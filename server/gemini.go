package main

// Cliente REST mínimo de Gemini (sin SDK, como hogarapp y Rondax): generateContent para leer imágenes y PDF escaneados
// y batchEmbedContents para los embeddings de la biblioteca. La clave (GEMINI_API_KEY, exclusiva de NAO) solo vive en
// el servidor.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

const geminiREST = "https://generativelanguage.googleapis.com/v1beta/models/"

// Precios en US$ por millón de tokens (APPROX: tabla de hogarapp y models.json de Rondax, 2026-10; revisar con
// la lista oficial de Google). La lectura usa el modelo más económico; el embedding, gemini-embedding-2 (el 001 está
// en desuso).
const (
	visionInPer1M  = 0.25
	visionOutPer1M = 1.50
	embedInPer1M   = 0.20
	embedDims      = 1536 // columnas vector(1536); gemini-embedding-2 recorta por MRL
	embedBatch     = 100  // máximo por llamada de batchEmbedContents
)

var geminiHTTP = &http.Client{Timeout: 120 * time.Second}

type geminiUsage struct {
	PromptTokenCount     int `json:"promptTokenCount"`
	CandidatesTokenCount int `json:"candidatesTokenCount"`
}

func (u geminiUsage) visionCost() float64 {
	return float64(u.PromptTokenCount)*visionInPer1M/1e6 + float64(u.CandidatesTokenCount)*visionOutPer1M/1e6
}

func geminiPost(ctx context.Context, method string, payload any) ([]byte, error) {
	key := envOr("GEMINI_API_KEY", "")
	if key == "" {
		return nil, errors.New("falta la clave de Gemini en el servidor")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, geminiREST+method+"?key="+key, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	res, err := geminiHTTP.Do(req)
	if err != nil {
		log.Printf("gemini %s: %v", method, err)
		return nil, errors.New("no se pudo conectar con Gemini")
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct{ Message string } `json:"error"`
		}
		_ = json.Unmarshal(raw, &e)
		return nil, fmt.Errorf("Gemini respondió %d: %s", res.StatusCode, truncate(e.Error.Message, 200))
	}
	return raw, nil
}

// geminiRead: texto de un archivo (imagen o PDF) con una instrucción, a temperatura baja
func geminiRead(ctx context.Context, model, prompt, mime string, data []byte) (string, geminiUsage, error) {
	payload := map[string]any{
		"contents": []any{map[string]any{"parts": []any{
			map[string]any{"text": prompt},
			map[string]any{"inline_data": map[string]string{"mime_type": mime, "data": base64.StdEncoding.EncodeToString(data)}},
		}}},
		"generationConfig": map[string]any{"temperature": 0.1},
	}
	raw, err := geminiPost(ctx, model+":generateContent", payload)
	if err != nil {
		return "", geminiUsage{}, err
	}
	var parsed struct {
		Candidates []struct {
			Content struct {
				Parts []struct{ Text string } `json:"parts"`
			} `json:"content"`
		} `json:"candidates"`
		UsageMetadata geminiUsage `json:"usageMetadata"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", geminiUsage{}, err
	}
	var out bytes.Buffer
	for _, c := range parsed.Candidates {
		for _, p := range c.Content.Parts {
			out.WriteString(p.Text)
		}
	}
	return out.String(), parsed.UsageMetadata, nil
}

// geminiEmbed: un vector por texto, en lotes de 100. gemini-embedding-2 no usa taskType: la tarea va en el texto
// ("title: … | text: …" para lo que se guarda; las consultas usarán "task: search result | query: …", como Rondax).
func geminiEmbed(ctx context.Context, model, title string, texts []string) ([][]float32, error) {
	out := make([][]float32, 0, len(texts))
	for start := 0; start < len(texts); start += embedBatch {
		end := min(start+embedBatch, len(texts))
		reqs := make([]any, 0, end-start)
		for _, t := range texts[start:end] {
			reqs = append(reqs, map[string]any{
				"model":                "models/" + model,
				"content":              map[string]any{"parts": []any{map[string]string{"text": "title: " + title + " | text: " + t}}},
				"outputDimensionality": embedDims,
			})
		}
		raw, err := geminiPost(ctx, model+":batchEmbedContents", map[string]any{"requests": reqs})
		if err != nil {
			return nil, err
		}
		var parsed struct {
			Embeddings []struct {
				Values []float32 `json:"values"`
			} `json:"embeddings"`
		}
		if err := json.Unmarshal(raw, &parsed); err != nil {
			return nil, err
		}
		if len(parsed.Embeddings) != end-start {
			return nil, errors.New("Gemini devolvió menos vectores de los pedidos")
		}
		for _, e := range parsed.Embeddings {
			if len(e.Values) != embedDims {
				return nil, fmt.Errorf("vector de %d dimensiones (se esperaban %d)", len(e.Values), embedDims)
			}
			out = append(out, e.Values)
		}
	}
	return out, nil
}
