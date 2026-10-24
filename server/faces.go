package main

// Rostros que reconoce el NAO de cada usuario (F11). Ley 1581 de 2012 (datos biométricos = sensibles): solo con
// autorización expresa (consent_at obligatorio, la casilla del navegador), solo la huella numérica de 128 valores
// (face-api, src/ai/faces.ts), nunca la foto, y se borra cuando se pida. La comparación se hace en el navegador: el
// servidor guarda y devuelve las huellas del propio usuario, nunca las de otros.
//
//   GET    /api/faces               personas registradas con sus huellas
//   POST   /api/faces               { name, consent: true, embeddings: [[128 números], …] } (1–5 muestras)
//   DELETE /api/faces/{name}        borra a esa persona (todas sus muestras)

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
	maxFaceSamples   = 5
	maxFacePeople    = 20
	maxFaceNameRunes = 40
	maxFaceBody      = 64 << 10
)

type facePerson struct {
	Name       string      `json:"name"`
	ConsentAt  time.Time   `json:"consentAt"`
	Embeddings [][]float64 `json:"embeddings"`
}

func (a *auth) handleListFaces(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT person_name, consent_at, embedding::text FROM faces WHERE user_id = $1 ORDER BY id`, u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo leer")
		return
	}
	defer rows.Close()
	people := []*facePerson{}
	byName := map[string]*facePerson{}
	for rows.Next() {
		var name, vec string
		var consent time.Time
		if err := rows.Scan(&name, &consent, &vec); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo leer")
			return
		}
		emb, ok := parseVector(vec)
		if !ok {
			continue
		}
		p := byName[name]
		if p == nil {
			p = &facePerson{Name: name, ConsentAt: consent}
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
	var body struct {
		Name       string      `json:"name"`
		Consent    bool        `json:"consent"`
		Embeddings [][]float64 `json:"embeddings"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFaceBody)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "petición inválida")
		return
	}
	name := strings.TrimSpace(body.Name)
	switch {
	case !body.Consent:
		writeError(w, http.StatusBadRequest, "hace falta la autorización de la persona")
		return
	case name == "" || utf8.RuneCountInString(name) > maxFaceNameRunes:
		writeError(w, http.StatusBadRequest, "el nombre debe tener entre 1 y 40 caracteres")
		return
	case len(body.Embeddings) == 0 || len(body.Embeddings) > maxFaceSamples:
		writeError(w, http.StatusBadRequest, "entre 1 y 5 muestras")
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
	// Registrar de nuevo a alguien reemplaza sus muestras anteriores
	tx, err := a.db.Begin(ctx)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	if _, err := tx.Exec(ctx, `DELETE FROM faces WHERE user_id = $1 AND person_name = $2`, u.ID, name); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo guardar")
		return
	}
	for _, e := range body.Embeddings {
		if _, err := tx.Exec(ctx, `INSERT INTO faces (user_id, person_name, embedding, consent_at) VALUES ($1, $2, $3::vector, now())`, u.ID, name, formatVector(e)); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
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
