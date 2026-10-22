package main

import (
	"archive/zip"
	"bytes"
	"context"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/xuri/excelize/v2"
)

func TestChunkTextAvanzaYSolapa(t *testing.T) {
	text := strings.Repeat("El NAO camina por la sala y saluda. ", 400) // ~14 000 caracteres
	chunks := chunkText(text)
	if len(chunks) < 10 {
		t.Fatalf("muy pocos trozos: %d", len(chunks))
	}
	for i, c := range chunks {
		if n := utf8.RuneCountInString(c); n > 1000 || n == 0 {
			t.Fatalf("trozo %d de %d caracteres", i, n)
		}
	}
	// Sin espacios ni puntos también termina (corte duro)
	if n := len(chunkText(strings.Repeat("ñ", 5000))); n < 5 || n > 7 {
		t.Fatalf("corte duro: %d trozos", n)
	}
}

func TestClasificaPorContenido(t *testing.T) {
	if _, err := classify("foto.jpg", []byte("<html><script>")); err == nil {
		t.Fatal("un HTML con extensión .jpg no debe pasar")
	}
	if k, err := classify("notas.md", []byte("# Hola\nNAO")); err != nil || k.kind != "text" {
		t.Fatalf("md: %v %v", k, err)
	}
	if _, err := classify("viejo.xls", []byte{0xD0, 0xCF}); err == nil || !strings.Contains(err.Error(), ".xlsx") {
		t.Fatalf("xls: %v", err)
	}
}

func TestDocx(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("word/document.xml")
	_, _ = w.Write([]byte(`<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Hola</w:t></w:r><w:r><w:t xml:space="preserve"> NAO</w:t></w:r></w:p><w:p><w:r><w:t>Segunda línea</w:t></w:r></w:p></w:body></w:document>`))
	_ = zw.Close()
	k, err := classify("tarea.docx", buf.Bytes())
	if err != nil || k.kind != "word" {
		t.Fatalf("docx: %v %v", k, err)
	}
	text, _, err := extractText(context.Background(), k.kind, k.mime, buf.Bytes())
	if err != nil || text != "Hola NAO\nSegunda línea" {
		t.Fatalf("texto %q, %v", text, err)
	}
}

func TestXlsxYCsv(t *testing.T) {
	f := excelize.NewFile()
	_ = f.SetSheetRow("Sheet1", "A1", &[]any{"Nombre", "Nota"})
	_ = f.SetSheetRow("Sheet1", "A2", &[]any{"Ana | B", 4.5})
	var buf bytes.Buffer
	_ = f.Write(&buf)
	k, err := classify("notas.xlsx", buf.Bytes())
	if err != nil || k.kind != "excel" {
		t.Fatalf("xlsx: %v %v", k, err)
	}
	text, _, err := extractText(context.Background(), k.kind, k.mime, buf.Bytes())
	if err != nil || !strings.Contains(text, "| Nombre | Nota |") || !strings.Contains(text, `Ana \| B`) {
		t.Fatalf("xlsx texto %q, %v", text, err)
	}
	csvData := []byte("nombre;nota\nAna;4,5\n")
	k, _ = classify("notas.csv", csvData)
	text, _, err = extractText(context.Background(), k.kind, k.mime, csvData)
	if err != nil || !strings.Contains(text, "| Ana | 4,5 |") {
		t.Fatalf("csv texto %q, %v", text, err)
	}
}

func TestLatin1(t *testing.T) {
	if got := decodeText([]byte{'a', 0xF1, 'o'}); got != "año" {
		t.Fatalf("latin-1: %q", got)
	}
}
