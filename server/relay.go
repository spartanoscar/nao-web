package main

// Sala del teléfono por QR (patrón de hv.bukivo.com, server/ask/relay.go), con estos cambios:
//
//   - La sala la crea el servidor (POST /api/rooms) para un usuario con sesión: el código es un token aleatorio
//     de 16 bytes (no 6 letras adivinables) y solo el dueño puede abrirla como pantalla.
//   - Un solo teléfono por sala: uno nuevo reemplaza al anterior (recargar la página del móvil no la bloquea).
//   - Pasa texto y binario sin leerlos (inclinación, botones, y la vista del NAO en JPEG hacia el teléfono), con
//     mensajes de hasta 512 KB.
//
// GET /api/ws?room=<código>&role=screen|phone. Lo que manda el teléfono va a la pantalla y viceversa.
// Una sala sin pantalla por más de 10 min se borra; crear una sala nueva cierra la anterior del mismo usuario.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	maxMessage     = 512 << 10
	maxRooms       = 200
	msgsPerSecond  = 60 // el teléfono manda la inclinación a ~30/s
	msgBurst       = 120
	writeWait      = 5 * time.Second
	pongWait       = 70 * time.Second
	pingEvery      = 30 * time.Second
	sendBufferSize = 32
	orphanTTL      = 10 * time.Minute
)

var roomCode = regexp.MustCompile(`^[A-Za-z0-9_-]{22}$`)

type frame struct {
	kind int // websocket.TextMessage o BinaryMessage
	data []byte
}

type conn struct {
	ws   *websocket.Conn
	send chan frame
	role string
}

type room struct {
	owner      int64
	ownerName  string
	robotName  string
	screen     *conn
	phone      *conn
	screenGone time.Time
}

type relay struct {
	auth    *auth
	mu      sync.Mutex
	rooms   map[string]*room
	origins map[string]bool
	up      websocket.Upgrader
}

func newRelay(a *auth) *relay {
	r := &relay{auth: a, rooms: map[string]*room{}, origins: map[string]bool{}}
	for _, h := range strings.Split(envOr("NAO_ALLOWED_ORIGINS", "nao.bukivo.com,localhost,127.0.0.1"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			r.origins[h] = true
		}
	}
	r.up = websocket.Upgrader{ReadBufferSize: 4096, WriteBufferSize: 16384, CheckOrigin: r.allowedOrigin}
	go r.janitor()
	return r
}

// Solo nuestras propias páginas abren el socket
func (r *relay) allowedOrigin(req *http.Request) bool {
	u, err := url.Parse(req.Header.Get("Origin"))
	return err == nil && u.Host != "" && r.origins[u.Hostname()]
}

// POST /api/rooms: sala nueva para el usuario de la sesión → {"room": "<código>"}
func (r *relay) handleCreateRoom(w http.ResponseWriter, req *http.Request) {
	u, err := r.auth.current(req)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo crear la sala")
		return
	}
	code := base64.RawURLEncoding.EncodeToString(buf)

	r.mu.Lock()
	defer r.mu.Unlock()
	for c, rm := range r.rooms {
		if rm.owner == u.ID {
			r.closeRoom(c, rm, "replaced")
		}
	}
	if len(r.rooms) >= maxRooms {
		writeError(w, http.StatusServiceUnavailable, "servidor ocupado")
		return
	}
	r.rooms[code] = &room{owner: u.ID, ownerName: u.DisplayName, robotName: u.RobotName, screenGone: time.Now()}
	writeJSON(w, http.StatusOK, map[string]string{"room": code})
}

func (r *relay) handleWS(w http.ResponseWriter, req *http.Request) {
	code := req.URL.Query().Get("room")
	role := req.URL.Query().Get("role")
	if !roomCode.MatchString(code) || (role != "screen" && role != "phone") {
		http.Error(w, "sala o rol inválidos", http.StatusBadRequest)
		return
	}
	var owner int64 = -1
	if role == "screen" {
		u, err := r.auth.current(req)
		if err != nil {
			http.Error(w, "inicia sesión", http.StatusUnauthorized)
			return
		}
		owner = u.ID
	}

	ws, err := r.up.Upgrade(w, req, nil)
	if err != nil {
		return // Upgrade ya respondió el error HTTP
	}
	c := &conn{ws: ws, send: make(chan frame, sendBufferSize), role: role}
	if reason := r.join(code, c, owner); reason != "" {
		_ = ws.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, reason), time.Now().Add(writeWait))
		ws.Close()
		return
	}
	go c.writeLoop()
	r.readLoop(code, c)
}

// join: la pantalla debe ser del dueño; el teléfono necesita la pantalla presente (el QR solo lo muestra una
// pantalla viva, así que sin ella el enlace es viejo)
func (r *relay) join(code string, c *conn, owner int64) string {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm := r.rooms[code]
	if rm == nil {
		return "no room"
	}
	if c.role == "screen" {
		if rm.owner != owner {
			return "not yours"
		}
		if rm.screen != nil {
			rm.screen.ws.Close() // recargar la página del escritorio toma el control
		}
		rm.screen = c
	} else {
		if rm.screen == nil {
			return "no screen"
		}
		if rm.phone != nil {
			trySend(rm.phone, text(map[string]any{"t": "replaced"}))
			rm.phone.ws.Close()
		}
		rm.phone = c
		trySend(c, text(map[string]any{"t": "welcome", "name": rm.ownerName, "robot": rm.robotName}))
	}
	r.announce(rm)
	return ""
}

func (r *relay) leave(code string, c *conn) {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm := r.rooms[code]
	if rm == nil {
		return
	}
	switch c {
	case rm.screen:
		rm.screen = nil
		rm.screenGone = time.Now()
		if rm.phone != nil {
			trySend(rm.phone, text(map[string]any{"t": "gone"}))
		}
	case rm.phone:
		rm.phone = nil
	default:
		return
	}
	r.announce(rm)
}

// closeRoom con r.mu tomado
func (r *relay) closeRoom(code string, rm *room, reason string) {
	for _, c := range []*conn{rm.screen, rm.phone} {
		if c != nil {
			trySend(c, text(map[string]any{"t": reason}))
			c.ws.Close()
		}
	}
	delete(r.rooms, code)
}

// announce: quién está conectado (con r.mu tomado)
func (r *relay) announce(rm *room) {
	msg := text(map[string]any{"t": "peers", "screen": rm.screen != nil, "phone": rm.phone != nil})
	for _, c := range []*conn{rm.screen, rm.phone} {
		if c != nil {
			trySend(c, msg)
		}
	}
}

func (r *relay) janitor() {
	for range time.Tick(time.Minute) {
		r.mu.Lock()
		for code, rm := range r.rooms {
			if rm.screen == nil && time.Since(rm.screenGone) > orphanTTL {
				r.closeRoom(code, rm, "gone")
			}
		}
		r.mu.Unlock()
	}
}

func (r *relay) readLoop(code string, c *conn) {
	defer func() {
		r.leave(code, c)
		close(c.send)
	}()
	c.ws.SetReadLimit(maxMessage)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error { return c.ws.SetReadDeadline(time.Now().Add(pongWait)) })

	tokens := float64(msgBurst)
	last := time.Now()
	for {
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		// Cubeta de fichas: una avalancha se descarta, no se reenvía
		now := time.Now()
		tokens = min(float64(msgBurst), tokens+now.Sub(last).Seconds()*msgsPerSecond)
		last = now
		if tokens < 1 {
			continue
		}
		tokens--

		r.mu.Lock()
		if rm := r.rooms[code]; rm != nil {
			to := rm.screen
			if c == rm.screen {
				to = rm.phone
			} else if c != rm.phone {
				to = nil // conexión reemplazada que aún no se cerró
			}
			if to != nil {
				trySend(to, frame{kind, data})
			}
		}
		r.mu.Unlock()
	}
}

func (c *conn) writeLoop() {
	ping := time.NewTicker(pingEvery)
	defer func() {
		ping.Stop()
		c.ws.Close()
	}()
	for {
		select {
		case f, ok := <-c.send:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.ws.WriteMessage(websocket.CloseMessage, nil)
				return
			}
			if err := c.ws.WriteMessage(f.kind, f.data); err != nil {
				return
			}
		case <-ping.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// trySend nunca bloquea: quien no alcanza a recibir pierde cuadros (el siguiente los reemplaza)
func trySend(c *conn, f frame) {
	defer func() { _ = recover() }() // canal cerrado por un cliente que se fue
	select {
	case c.send <- f:
	default:
	}
}

func text(v any) frame {
	data, _ := json.Marshal(v)
	return frame{websocket.TextMessage, data}
}
