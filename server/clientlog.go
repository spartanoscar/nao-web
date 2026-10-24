package main

// POST /api/client-log: el navegador cuenta que la vez anterior la pestaña se cerró sola (src/ui/crashLog.ts: etapa,
// últimos errores, dispositivo). Solo con sesión; queda en el registro de nao-api (pm2 logs nao-api), no en la BD.

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
)

const clientLogMax = 8 << 10

func (a *auth) handleClientLog(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, clientLogMax))
	if err != nil || !json.Valid(body) {
		writeError(w, http.StatusBadRequest, "registro inválido")
		return
	}
	var compact bytes.Buffer
	_ = json.Compact(&compact, body)
	log.Printf("cliente %s: %s", u.Username, compact.String())
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
