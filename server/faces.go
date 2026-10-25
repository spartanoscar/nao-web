package main

// Rostros que reconoce el NAO de cada usuario (F11; ALFaceDetection.learnFace/reLearnFace/forgetPerson, src/naoqi).
// Ley 1581 de 2012 (datos biométricos = sensibles): el NAO pregunta conversando si puede recordar la cara y solo la
// aprende si la persona dice que sí; esas palabras quedan como constancia (consent_note) con su fecha (consent_at).
// Solo la huella numérica de 128 valores (face-api, src/ai/faces.ts), nunca la foto, y se borra cuando se pida. La
// comparación se hace en el navegador: el servidor guarda y devuelve las huellas del propio usuario, nunca de otros.
//
//   GET    /api/faces          personas registradas con sus huellas
//   POST   /api/faces          { name, consent: true, consentNote, embeddings: [[128 números], …], append }
//                              learnFace: reemplaza sus muestras; append (reLearnFace): las suma, máx. 10 (rueda)
//   DELETE /api/faces/{name}   forgetPerson: borra todas sus muestras

import (
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	faceDims         = 128
	maxFaceSamples   = 10 // "Up to 10 images can be stored for each person" (doc de reLearnFace)
	maxFacePeople    = 20
	maxFaceNameRunes = 40
	maxFaceBody      = 64 << 10
)

type facePerson struct {
	Name        string      `json:"name"`
	ConsentAt   time.Time   `json:"consentAt"`
	ConsentNote string      `json:"consentNote"`
	Embeddings  [][]float64 `json:"embeddings"`
}

func (a *auth) handleListFaces(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT person_name, consent_at, COALESCE(consent_note, ''), embedding::text FROM faces WHERE user_id = $1 ORDER BY id`, u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo leer")
		return
	}
	defer rows.Close()
	people := []*facePerson{}
	byName := map[string]*facePerson{}
	for rows.Next() {
		var name, note, vec string
		var consent time.Time
		if err := rows.Scan(&name, &consent, &note, &vec); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo leer")
			return
		}
		emb, ok := parseVector(vec)
		if !ok {
			continue
		}
		p := byName[name]
		if p == nil {
			p = &facePerson{Name: name, ConsentAt: consent, ConsentNote: note}
			byName[name] = p
			people = append(people, p)
		}
		p.Embeddings = append(p.Embeddings, emb)
	}
	writeJSON(w, http.StatusOK, map[string]any{"people": people})
}

func (a *auth) handleAddFace(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	if u.demo() {
		writeError(w, http.StatusForbidden, demoReadOnly)
		return
	}
	var body struct {
		Name        string      `json:"name"`
		Consent     bool        `json:"consent"`
		ConsentNote string      `json:"consentNote"`
		Embeddings  [][]float64 `json:"embeddings"`
		Append      bool        `json:"append"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFaceBody)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "petición inválida")
		return
	}
	name := strings.TrimSpace(body.Name)
	note := strings.TrimSpace(body.ConsentNote)
	switch {
	case !body.Consent || note == "" || utf8.RuneCountInString(note) > 300:
		writeError(w, http.StatusBadRequest, "hace falta la autorización de la persona (sus palabras)")
		return
	case name == "" || utf8.RuneCountInString(name) > maxFaceNameRunes:
		writeError(w, http.StatusBadRequest, "el nombre debe tener entre 1 y 40 caracteres")
		return
	case len(body.Embeddings) == 0 || len(body.Embeddings) > maxFaceSamples:
		writeError(w, http.StatusBadRequest, "entre 1 y 10 muestras")
		return
	}
	for _, e := range body.Embeddings {
		if !validEmbedding(e) {
			writeError(w, http.StatusBadRequest, "huella inválida")
			return
		}
	}
	ctx := r.Context()
	var people, mine int
	if err := a.db.QueryRow(ctx, `SELECT count(DISTINCT person_name), count(*) FILTER (WHERE person_name = $2) FROM faces WHERE user_id = $1`, u.ID, name).Scan(&people, &mine); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	if mine == 0 && people >= maxFacePeople {
		writeError(w, http.StatusBadRequest, "ya hay 20 personas registradas: borra alguna")
		return
	}
	if body.Append && mine == 0 {
		writeError(w, http.StatusBadRequest, "no conozco a esa persona: primero hay que aprender su cara")
		return
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	// learnFace: aprender de nuevo a alguien reemplaza sus muestras; reLearnFace (append) las suma
	if !body.Append {
		if _, err := tx.Exec(ctx, `DELETE FROM faces WHERE user_id = $1 AND person_name = $2`, u.ID, name); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	for _, e := range body.Embeddings {
		if _, err := tx.Exec(ctx, `INSERT INTO faces (user_id, person_name, embedding, consent_at, consent_note) VALUES ($1, $2, $3::vector, now(), $4)`,
			u.ID, name, formatVector(e), note); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	// Máximo 10 muestras por persona: las más viejas salen (rueda, como reLearnFace)
	if _, err := tx.Exec(ctx, `DELETE FROM faces WHERE id IN (
		SELECT id FROM faces WHERE user_id = $1 AND person_name = $2 ORDER BY id DESC OFFSET $3)`, u.ID, name, maxFaceSamples); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "samples": len(body.Embeddings)})
}

func (a *auth) handleDeleteFace(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	if u.demo() {
		writeError(w, http.StatusForbidden, demoReadOnly)
		return
	}
	name := strings.TrimSpace(r.PathValue("name"))
	tag, err := a.db.Exec(r.Context(), `DELETE FROM faces WHERE user_id = $1 AND person_name = $2`, u.ID, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo borrar")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": tag.RowsAffected()})
}

func validEmbedding(e []float64) bool {
	if len(e) != faceDims {
		return false
	}
	for _, v := range e {
		if math.IsNaN(v) || math.IsInf(v, 0) || math.Abs(v) > 10 {
			return false
		}
	}
	return true
}

// formatVector: texto de pgvector, "[a,b,…]"
func formatVector(e []float64) string {
	var b strings.Builder
	b.WriteByte('[')
	for i, v := range e {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(v, 'g', 7, 64))
	}
	b.WriteByte(']')
	return b.String()
}

func parseVector(s string) ([]float64, bool) {
	s = strings.TrimSpace(s)
	if len(s) < 2 || s[0] != '[' || s[len(s)-1] != ']' {
		return nil, false
	}
	parts := strings.Split(s[1:len(s)-1], ",")
	out := make([]float64, 0, len(parts))
	for _, p := range parts {
		v, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
		if err != nil {
			return nil, false
		}
		out = append(out, v)
	}
	return out, len(out) == faceDims
}
