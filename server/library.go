package main

// Biblioteca del jugador (modal de ajustes → Biblioteca), migrada de hogarapp (bot.hogarapp.com) con lo que le faltaba:
// estados en la BD (pending → processing → ready | error) procesados por un trabajador que sobrevive a reinicios,
// reintentos con espera, límites (4 MB por archivo, 30 por persona) y cobro de cada lectura y embedding al dueño.
//
//	GET    /api/documents             lista del usuario
//	POST   /api/documents             multipart: file (+ thumb JPEG opcional, la miniatura de una imagen)
//	GET    /api/documents/{id}/file   el archivo (en línea si se puede ver; si no, descarga). ?download=1 fuerza descarga
//	GET    /api/documents/{id}/thumb  miniatura
//	DELETE /api/documents/{id}

import (
	"context"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	maxFileBytes   = 4 << 20
	maxThumbBytes  = 64 << 10
	maxDocsPerUser = 30
	maxAttempts    = 3
	maxTitleRunes  = 120
	staleAfter     = 10 * time.Minute // un "processing" más viejo que esto se retoma (el proceso se reinició)
)

type document struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	Kind      string    `json:"kind"`
	Mime      string    `json:"mime"`
	Size      int       `json:"size"`
	Status    string    `json:"status"`
	Error     string    `json:"error,omitempty"`
	HasThumb  bool      `json:"hasThumb"`
	CreatedAt time.Time `json:"createdAt"`
}

const documentColumns = `id, title, kind, mime, size_bytes, status, COALESCE(error, ''), thumb IS NOT NULL, created_at`

func scanDocument(row pgx.Row) (document, error) {
	var d document
	err := row.Scan(&d.ID, &d.Title, &d.Kind, &d.Mime, &d.Size, &d.Status, &d.Error, &d.HasThumb, &d.CreatedAt)
	return d, err
}

func (a *auth) handleListDocuments(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT `+documentColumns+` FROM documents WHERE owner_id = $1 ORDER BY created_at DESC`, u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "error de base de datos")
		return
	}
	defer rows.Close()
	docs := []document{}
	for rows.Next() {
		d, err := scanDocument(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "error de base de datos")
			return
		}
		docs = append(docs, d)
	}
	writeJSON(w, http.StatusOK, docs)
}

func (a *auth) handleUploadDocument(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	if u.demo() {
		writeError(w, http.StatusForbidden, demoReadOnly)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFileBytes+maxThumbBytes+(64<<10))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "el archivo supera los 4 MB")
		return
	}
	defer r.MultipartForm.RemoveAll()
	f, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "falta el archivo")
		return
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, maxFileBytes+1))
	if err != nil || len(data) == 0 {
		writeError(w, http.StatusBadRequest, "el archivo está vacío")
		return
	}
	if len(data) > maxFileBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "el archivo supera los 4 MB")
		return
	}
	kind, err := classify(header.Filename, data)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	var thumb []byte
	if tf, _, err := r.FormFile("thumb"); err == nil {
		thumb, _ = io.ReadAll(io.LimitReader(tf, maxThumbBytes+1))
		tf.Close()
		if len(thumb) > maxThumbBytes || http.DetectContentType(thumb) != "image/jpeg" {
			thumb = nil
		}
	}

	ctx := r.Context()
	var count int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM documents WHERE owner_id = $1`, u.ID).Scan(&count); err != nil {
		writeError(w, http.StatusInternalServerError, "error de base de datos")
		return
	}
	if count >= maxDocsPerUser {
		writeError(w, http.StatusBadRequest, "tu biblioteca ya tiene 30 archivos: borra alguno para subir otro")
		return
	}
	if spent, limit, err := spending(ctx, a.db, u.ID); err == nil && spent >= limit {
		writeError(w, http.StatusPaymentRequired, "no te quedan tokens hoy: mañana se renuevan")
		return
	}
	d, err := scanDocument(a.db.QueryRow(ctx, `
		INSERT INTO documents (owner_id, title, source, kind, mime, size_bytes, content, thumb, status)
		VALUES ($1, $2, 'upload', $3, $4, $5, $6, $7, 'pending') RETURNING `+documentColumns,
		u.ID, cleanTitle(header.Filename), kind.kind, kind.mime, len(data), data, thumb))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar el archivo")
		return
	}
	writeJSON(w, http.StatusCreated, d)
}

// handleDocumentFile: el original. Se ve en línea lo que el navegador muestra sin riesgo (imagen, PDF, texto plano);
// lo demás se descarga. COEP/CORP permiten mostrarlo en el visor (iframe) de una página aislada.
func (a *auth) handleDocumentFile(w http.ResponseWriter, r *http.Request) {
	a.serveDocument(w, r, "content")
}

func (a *auth) handleDocumentThumb(w http.ResponseWriter, r *http.Request) {
	a.serveDocument(w, r, "thumb")
}

func (a *auth) serveDocument(w http.ResponseWriter, r *http.Request, column string) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var title, kind, mimeType string
	var data []byte
	err = a.db.QueryRow(r.Context(), `SELECT title, kind, mime, `+column+` FROM documents WHERE id = $1 AND owner_id = $2`, id, u.ID).
		Scan(&title, &kind, &mimeType, &data)
	if err != nil || data == nil {
		http.NotFound(w, r)
		return
	}
	h := w.Header()
	h.Set("Cache-Control", "private, max-age=3600")
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("Cross-Origin-Embedder-Policy", "require-corp")
	if column == "thumb" {
		h.Set("Content-Type", "image/jpeg")
		_, _ = w.Write(data)
		return
	}
	inline := kind == "image" || kind == "pdf" || strings.HasPrefix(mimeType, "text/")
	if strings.HasPrefix(mimeType, "text/") {
		h.Set("Content-Type", "text/plain; charset=utf-8") // nunca HTML: lo subido no se ejecuta
	} else {
		h.Set("Content-Type", mimeType)
	}
	disposition := "attachment"
	if inline && r.URL.Query().Get("download") == "" {
		disposition = "inline"
	}
	h.Set("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": title}))
	if strings.HasPrefix(mimeType, "text/") {
		h.Set("Content-Security-Policy", "sandbox")
	}
	_, _ = w.Write(data)
}

func (a *auth) handleDeleteDocument(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	if u.demo() {
		writeError(w, http.StatusForbidden, demoReadOnly)
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	tag, err := a.db.Exec(r.Context(), `DELETE FROM documents WHERE id = $1 AND owner_id = $2`, id, u.ID)
	if err != nil || tag.RowsAffected() == 0 {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func cleanTitle(name string) string {
	name = strings.TrimSpace(filepath.Base(strings.ReplaceAll(name, "\\", "/")))
	if name == "" || name == "." || name == "/" {
		name = "archivo"
	}
	if utf8.RuneCountInString(name) > maxTitleRunes {
		ext := filepath.Ext(name)
		name = string([]rune(strings.TrimSuffix(name, ext))[:maxTitleRunes-len([]rune(ext))]) + ext
	}
	return name
}

// ─── Trabajador ───────────────────────────────────────────────────────────────

// retryable: fallos pasajeros (red, Gemini saturado) que vale la pena reintentar; lo demás (archivo ilegible, sin
// tokens) se marca como error de una vez
type retryable struct{ error }

func startLibraryWorker(db *pgxpool.Pool) {
	go func() {
		for {
			if !processNext(db) {
				time.Sleep(2 * time.Second)
			}
		}
	}()
}

// processNext toma un documento pendiente (o uno que quedó "processing" por un reinicio) y lo procesa
func processNext(db *pgxpool.Pool) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	var id int64
	var owner *int64
	var title, kind, mimeType string
	var data []byte
	var attempts int
	err := db.QueryRow(ctx, `
		UPDATE documents SET status = 'processing', attempts = attempts + 1, updated_at = now()
		WHERE id = (SELECT id FROM documents
		            WHERE (status = 'pending' AND updated_at <= now())
		               OR (status = 'processing' AND updated_at < now() - interval '`+strconv.Itoa(int(staleAfter.Minutes()))+` minutes')
		            ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED)
		RETURNING id, owner_id, title, kind, mime, content, attempts`).Scan(&id, &owner, &title, &kind, &mimeType, &data, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return false
	}
	if err != nil {
		log.Printf("biblioteca: no se pudo tomar un documento: %v", err)
		return false
	}
	err = processDocument(ctx, db, id, owner, title, kind, mimeType, data)
	switch {
	case err == nil:
		return true
	case errors.As(err, new(retryable)) && attempts < maxAttempts:
		// Espera creciente: 30 s, 60 s…
		_, _ = db.Exec(ctx, `UPDATE documents SET status = 'pending', error = $2, updated_at = now() + make_interval(secs => $3) WHERE id = $1`,
			id, err.Error(), attempts*30)
	default:
		_, _ = db.Exec(ctx, `UPDATE documents SET status = 'error', error = $2, updated_at = now() WHERE id = $1`, id, err.Error())
	}
	log.Printf("biblioteca: documento %d (intento %d): %v", id, attempts, err)
	return true
}

func processDocument(ctx context.Context, db *pgxpool.Pool, id int64, owner *int64, title, kind, mimeType string, data []byte) error {
	visionModel := envOr("NAO_VISION_MODEL", "gemini-3.1-flash-lite-preview")
	embedModel := envOr("NAO_EMBED_MODEL", "gemini-embedding-2")
	total := 0.0

	text, read, err := extractText(ctx, kind, mimeType, data)
	if read.PromptTokenCount > 0 && owner != nil {
		cost := read.visionCost()
		total += cost
		if _, cerr := charge(ctx, db, *owner, visionUsage(visionModel, read, cost)); cerr != nil {
			log.Printf("biblioteca: no se pudo cobrar la lectura del documento %d: %v", id, cerr)
		}
	}
	if err != nil {
		if strings.Contains(err.Error(), "Gemini") {
			return retryable{err}
		}
		return err
	}

	chunks := chunkText(text)
	// gemini-embedding-2 no devuelve el conteo: ≈ 4 caracteres por token (más el título que va en cada trozo)
	tokens := 0
	for _, c := range chunks {
		tokens += (utf8.RuneCountInString(c)+utf8.RuneCountInString(title)+16)/4 + 1
	}
	embedCost := float64(tokens) * embedInPer1M / 1e6
	if owner != nil {
		spent, limit, err := spending(ctx, db, *owner)
		if err != nil {
			return retryable{errors.New("no se pudo consultar el consumo")}
		}
		if spent+embedCost > limit {
			return errors.New("no te alcanzan los tokens de hoy para guardar este archivo")
		}
	}
	vectors, err := geminiEmbed(ctx, embedModel, title, chunks)
	if err != nil {
		return retryable{err}
	}
	total += embedCost
	if owner != nil {
		if _, err := charge(ctx, db, *owner, usage{Feature: "biblioteca", Model: embedModel, InputTokens: tokens, CostUSD: embedCost}); err != nil {
			log.Printf("biblioteca: no se pudo cobrar el embedding del documento %d: %v", id, err)
		}
	}

	tx, err := db.Begin(ctx)
	if err != nil {
		return retryable{err}
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `DELETE FROM document_chunks WHERE document_id = $1`, id); err != nil {
		return retryable{err}
	}
	for i, c := range chunks {
		if _, err := tx.Exec(ctx, `INSERT INTO document_chunks (document_id, position, content, embedding) VALUES ($1, $2, $3, $4::vector)`,
			id, i, c, vectorLiteral(vectors[i])); err != nil {
			return retryable{err}
		}
	}
	if _, err := tx.Exec(ctx, `
		UPDATE documents SET status = 'ready', error = NULL, extracted_text = $2, cost_usd = cost_usd + $3, updated_at = now()
		WHERE id = $1`, id, text, total); err != nil {
		return retryable{err}
	}
	return tx.Commit(ctx)
}

func visionUsage(model string, u geminiUsage, cost float64) usage {
	return usage{Feature: "biblioteca-lectura", Model: model, InputTokens: u.PromptTokenCount, OutputTokens: u.CandidatesTokenCount, CostUSD: cost}
}

func vectorLiteral(v []float32) string {
	var b strings.Builder
	b.Grow(len(v) * 10)
	b.WriteByte('[')
	for i, x := range v {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(float64(x), 'g', 7, 32))
	}
	b.WriteByte(']')
	return b.String()
}
