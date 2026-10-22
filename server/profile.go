package main

// Ajustes del jugador (modal de ajustes, sin botón de guardar: el navegador manda los cambios con 3 s de pausa).
// PATCH /api/me con solo los campos que cambiaron: displayName, robotName ("" = "NAO"), prompt, avatar (data URL
// JPEG ya recortado y reducido en el navegador, o "" para quitarla), shellColor y eyeColor ("#rrggbb" o "" = el
// original). GET /api/avatar devuelve la foto.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"
)

var hexColor = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

const (
	maxDisplayName = 40
	maxRobotName   = 24
	maxPrompt      = 2000
	maxAvatarBytes = 200 << 10
	maxPatchBody   = 320 << 10 // la foto en base64 ocupa ~4/3
)

func (a *auth) handlePatchMe(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	var body struct {
		DisplayName *string `json:"displayName"`
		RobotName   *string `json:"robotName"`
		Prompt      *string `json:"prompt"`
		Avatar      *string `json:"avatar"`
		ShellColor  *string `json:"shellColor"`
		EyeColor    *string `json:"eyeColor"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxPatchBody)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "petición inválida")
		return
	}
	ctx := r.Context()
	if body.DisplayName != nil {
		name := strings.TrimSpace(*body.DisplayName)
		if name == "" || utf8.RuneCountInString(name) > maxDisplayName {
			writeError(w, http.StatusBadRequest, "tu nombre debe tener entre 1 y 40 caracteres")
			return
		}
		if _, err := a.db.Exec(ctx, `UPDATE users SET display_name = $1 WHERE id = $2`, name, u.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	if body.RobotName != nil {
		name := strings.TrimSpace(*body.RobotName)
		if utf8.RuneCountInString(name) > maxRobotName {
			writeError(w, http.StatusBadRequest, "el nombre del NAO puede tener hasta 24 caracteres")
			return
		}
		var robot *string
		if name != "" && !strings.EqualFold(name, "NAO") {
			robot = &name
		}
		if _, err := a.db.Exec(ctx, `UPDATE users SET robot_name = $1 WHERE id = $2`, robot, u.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	if body.Prompt != nil {
		if utf8.RuneCountInString(*body.Prompt) > maxPrompt {
			writeError(w, http.StatusBadRequest, "las instrucciones pueden tener hasta 2000 caracteres")
			return
		}
		if _, err := a.db.Exec(ctx, `UPDATE users SET prompt = $1 WHERE id = $2`, *body.Prompt, u.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	if body.Avatar != nil {
		var img []byte
		if *body.Avatar != "" {
			data, ok := strings.CutPrefix(*body.Avatar, "data:image/jpeg;base64,")
			if !ok {
				writeError(w, http.StatusBadRequest, "la foto debe ser JPEG")
				return
			}
			img, err = base64.StdEncoding.DecodeString(data)
			// Firma JPEG (FF D8 FF): no se guarda cualquier cosa como foto
			if err != nil || len(img) > maxAvatarBytes || !bytes.HasPrefix(img, []byte{0xFF, 0xD8, 0xFF}) {
				writeError(w, http.StatusBadRequest, "foto inválida o muy grande")
				return
			}
		}
		if _, err := a.db.Exec(ctx, `UPDATE users SET avatar = $1, avatar_updated_at = now() WHERE id = $2`, img, u.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	for _, c := range []struct {
		value  *string
		column string
	}{{body.ShellColor, "shell_color"}, {body.EyeColor, "eye_color"}} {
		if c.value == nil {
			continue
		}
		var color *string
		if *c.value != "" {
			if !hexColor.MatchString(*c.value) {
				writeError(w, http.StatusBadRequest, "el color debe ser #rrggbb")
				return
			}
			lower := strings.ToLower(*c.value)
			color = &lower
		}
		if _, err := a.db.Exec(ctx, `UPDATE users SET `+c.column+` = $1 WHERE id = $2`, color, u.ID); err != nil {
			writeError(w, http.StatusInternalServerError, "no se pudo guardar")
			return
		}
	}
	updated, err := a.loadUser(ctx, u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "error de base de datos")
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// GET /api/avatar?v=…: la foto del usuario de la sesión (la URL cambia con cada foto, así que se puede cachear)
func (a *auth) handleAvatar(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	var img []byte
	if err := a.db.QueryRow(r.Context(), `SELECT avatar FROM users WHERE id = $1`, u.ID).Scan(&img); err != nil || img == nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	_, _ = w.Write(img)
}
