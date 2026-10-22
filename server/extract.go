package main

// Texto de cada tipo de archivo de la biblioteca. Lo gratuito primero: PDF con capa de texto, Word (XML interno),
// Excel/CSV (tablas en Markdown) y texto se leen aquí; solo las imágenes y los PDF escaneados pasan por Gemini (el
// modelo más económico), con el costo cobrado al dueño. hogarapp mandaba todo PDF entero a Gemini: caro e innecesario.

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/ledongthuc/pdf"
	"github.com/xuri/excelize/v2"
)

const (
	// Tope del texto que se vectoriza (≈ 50 000 tokens): un archivo de 4 MB no puede costar una fortuna
	maxExtractRunes = 200_000
	maxSheetRows    = 2000
	maxSheetCols    = 40
	// Un PDF con menos texto que esto es casi seguro escaneado: se lee con Gemini
	minPDFText = 200

	promptImage = "Extrae todo el texto visible de esta imagen y describe con detalle los gráficos, diagramas y cualquier " +
		"otro contenido visual. Responde solo en Markdown limpio, en el idioma de la imagen, sin comentarios."
	promptPDF = "Extrae TODO el texto de este PDF conservando su estructura en Markdown (títulos, listas, tablas). Incluye el " +
		"texto de imágenes y figuras. Responde solo con el Markdown, sin comentarios."
)

type fileKind struct {
	kind string // image | pdf | excel | word | text
	mime string
}

// classify: tipo permitido según la extensión y el contenido real (no se confía en lo que diga el navegador)
func classify(name string, data []byte) (fileKind, error) {
	ext := strings.ToLower(filepath.Ext(name))
	sniff := http.DetectContentType(data)
	isText := strings.HasPrefix(sniff, "text/plain") && utf8.Valid(data[:min(len(data), 4096)])
	switch {
	case ext == ".pdf" && sniff == "application/pdf":
		return fileKind{"pdf", "application/pdf"}, nil
	case (ext == ".jpg" || ext == ".jpeg" || ext == ".png" || ext == ".webp" || ext == ".gif") && strings.HasPrefix(sniff, "image/"):
		return fileKind{"image", sniff}, nil
	case ext == ".xlsx" && sniff == "application/zip":
		return fileKind{"excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}, nil
	case ext == ".csv" && (isText || strings.HasPrefix(sniff, "text/plain")):
		return fileKind{"excel", "text/csv"}, nil
	case ext == ".docx" && sniff == "application/zip":
		return fileKind{"word", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}, nil
	case (ext == ".txt" || ext == ".md") && strings.HasPrefix(sniff, "text/plain"):
		mime := "text/plain"
		if ext == ".md" {
			mime = "text/markdown"
		}
		return fileKind{"text", mime}, nil
	case ext == ".xls" || ext == ".doc":
		return fileKind{}, errors.New("ese formato es antiguo: guárdalo como .xlsx o .docx y súbelo de nuevo")
	}
	return fileKind{}, errors.New("tipo de archivo no permitido (imágenes, PDF, Word, Excel, CSV, TXT o MD)")
}

// extractText devuelve el texto y lo que costó leerlo (solo si pasó por Gemini)
func extractText(ctx context.Context, kind, mime string, data []byte) (string, geminiUsage, error) {
	var text string
	var usage geminiUsage
	var err error
	switch kind {
	case "image":
		text, usage, err = geminiRead(ctx, envOr("NAO_VISION_MODEL", "gemini-3.1-flash-lite-preview"), promptImage, mime, data)
	case "pdf":
		text, err = pdfText(data)
		if err != nil || len(strings.TrimSpace(text)) < minPDFText {
			text, usage, err = geminiRead(ctx, envOr("NAO_VISION_MODEL", "gemini-3.1-flash-lite-preview"), promptPDF, mime, data)
		}
	case "word":
		text, err = docxText(data)
	case "excel":
		if mime == "text/csv" {
			text, err = csvText(data)
		} else {
			text, err = xlsxText(data)
		}
	default:
		text = decodeText(data)
	}
	if err != nil {
		return "", usage, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return "", usage, errors.New("no encontramos texto en el archivo")
	}
	if utf8.RuneCountInString(text) > maxExtractRunes {
		text = string([]rune(text)[:maxExtractRunes])
	}
	return text, usage, nil
}

// pdfText: capa de texto del PDF (la librería puede entrar en pánico con PDF raros: se recupera)
func pdfText(data []byte) (text string, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("PDF ilegible: %v", r)
		}
	}()
	r, err := pdf.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", err
	}
	plain, err := r.GetPlainText()
	if err != nil {
		return "", err
	}
	b, err := io.ReadAll(io.LimitReader(plain, 8<<20))
	return string(b), err
}

// docxText: párrafos de word/document.xml (w:t = texto, w:tab, w:br, fin de w:p = salto de línea)
func docxText(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", errors.New("el archivo de Word está dañado")
	}
	for _, f := range zr.File {
		if f.Name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		defer rc.Close()
		dec := xml.NewDecoder(io.LimitReader(rc, 32<<20))
		var out strings.Builder
		inText := false
		for {
			tok, err := dec.Token()
			if err == io.EOF {
				break
			}
			if err != nil {
				return "", errors.New("el archivo de Word está dañado")
			}
			switch t := tok.(type) {
			case xml.StartElement:
				switch t.Name.Local {
				case "t":
					inText = true
				case "tab":
					out.WriteByte('\t')
				case "br":
					out.WriteByte('\n')
				}
			case xml.EndElement:
				switch t.Name.Local {
				case "t":
					inText = false
				case "p":
					out.WriteByte('\n')
				}
			case xml.CharData:
				if inText {
					out.Write(t)
				}
			}
		}
		return out.String(), nil
	}
	return "", errors.New("el archivo de Word está dañado")
}

// xlsxText: cada hoja como tabla Markdown (hasta 2000 filas y 40 columnas)
func xlsxText(data []byte) (string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return "", errors.New("el archivo de Excel está dañado")
	}
	defer f.Close()
	var out strings.Builder
	for _, sheet := range f.GetSheetList() {
		rows, err := f.GetRows(sheet)
		if err != nil || len(rows) == 0 {
			continue
		}
		fmt.Fprintf(&out, "## Hoja: %s\n\n", sheet)
		writeTable(&out, rows)
		out.WriteString("\n")
	}
	return out.String(), nil
}

// csvText: separador ";" (Excel en español) o ",", según la primera línea
func csvText(data []byte) (string, error) {
	text := decodeText(data)
	first, _, _ := strings.Cut(text, "\n")
	r := csv.NewReader(strings.NewReader(text))
	if strings.Count(first, ";") > strings.Count(first, ",") {
		r.Comma = ';'
	}
	r.LazyQuotes = true
	r.FieldsPerRecord = -1
	var rows [][]string
	for len(rows) < maxSheetRows {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", errors.New("el CSV no se pudo leer")
		}
		rows = append(rows, rec)
	}
	var out strings.Builder
	writeTable(&out, rows)
	return out.String(), nil
}

func writeTable(out *strings.Builder, rows [][]string) {
	cols := 0
	for _, r := range rows[:min(len(rows), maxSheetRows)] {
		cols = max(cols, min(len(r), maxSheetCols))
	}
	if cols == 0 {
		return
	}
	cell := func(r []string, i int) string {
		if i >= len(r) {
			return ""
		}
		return strings.NewReplacer("|", "\\|", "\n", " ", "\r", "").Replace(strings.TrimSpace(r[i]))
	}
	for n, r := range rows[:min(len(rows), maxSheetRows)] {
		out.WriteString("|")
		for i := 0; i < cols; i++ {
			out.WriteString(" " + cell(r, i) + " |")
		}
		out.WriteString("\n")
		if n == 0 {
			out.WriteString("|" + strings.Repeat(" --- |", cols) + "\n")
		}
	}
}

// decodeText: UTF-8, o Latin-1/Windows-1252 si no lo es (archivos viejos de Windows)
func decodeText(data []byte) string {
	data = bytes.TrimPrefix(data, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(data) {
		return string(data)
	}
	runes := make([]rune, len(data))
	for i, b := range data {
		runes[i] = rune(b)
	}
	return string(runes)
}

// chunkText: trozos de ~1000 caracteres con 120 de solapamiento, cortando en un párrafo, una línea, una frase o un
// espacio. Siempre avanza (el troceador de hogarapp podía retroceder y quedarse en un bucle).
func chunkText(text string) []string {
	const size, overlap = 1000, 120
	runes := []rune(text)
	var chunks []string
	for start := 0; start < len(runes); {
		end := min(start+size, len(runes))
		if end < len(runes) {
			window := string(runes[start+size/2 : end])
			for _, sep := range []string{"\n\n", "\n", ". ", " "} {
				if i := strings.LastIndex(window, sep); i >= 0 {
					end = start + size/2 + utf8.RuneCountInString(window[:i]) + utf8.RuneCountInString(sep)
					break
				}
			}
		}
		if c := strings.TrimSpace(string(runes[start:end])); c != "" {
			chunks = append(chunks, c)
		}
		if end >= len(runes) {
			break
		}
		start = max(end-overlap, start+1)
	}
	return chunks
}
