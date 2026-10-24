package main

// Mundo compartido (docs/PLAN.md F16): cada navegador simula su NAO y comparte su estado; aquí solo se lleva quién está.
//
//   - Presencia: quién tiene la pantalla abierta (la sala del teléfono, relay.go, se abre sola al entrar al mundo). A
//     todas las pantallas les llega {t:'world', pod, players:[{pod, name, robot, shell}]}: su cápsula y quién más está.
//   - Cápsulas: cada persona toma la primera libre en podOrder (las del medio primero). La conserva mientras su pantalla
//     vuelva en podGrace (recargar la página no la cambia de cápsula). Sin libres, entra sin cápsula (pod −1).
//   - Pase: POST /api/world/pass → {pass, url, pod}. Firmado con NAO_WORLD_SECRET (HMAC-SHA256, unos minutos): la sala
//     del mundo (el Durable Object de Cloudflare, world/, o el plan B de aquí) solo verifica la firma, sin base de datos.
//   - Plan B: GET /api/world?pass=… es la misma sala que el Durable Object (mismo protocolo) servida por nao-api. Se usa
//     si NAO_WORLD_URL está vacío.
//
// Protocolo de la sala del mundo (igual en world/src/index.ts):
//   cliente → sala: binario = estado del NAO (byte 0 = 1, byte 1 = cápsula, que la sala sobreescribe con la del pase)
//                   texto {t:'hi', robot, shell, eyes} (apariencia; al entrar y al cambiar) · {t:'say', text, voice}
//   sala → cliente: el binario de los demás tal cual · {t:'peers', pods:[…]} al entrar · {t:'join', pod} ·
//                   {t:'leave', pod} · {t:'hi', pod, …} · {t:'say', pod, text, voice}

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Orden en que se reparten las cápsulas (índices 0–7 de src/sim/pods.ts, de sur a norte). La 0 y la 6 tienen un NAO
// quieto que no es de nadie (pods.ts PARKED): hasta 6 personas en el mundo.
var podOrder = []int{3, 4, 2, 5, 1, 7}

const (
	podGrace      = 2 * time.Minute
	passTTL       = 5 * time.Minute
	worldMaxText  = 1024
	worldMaxState = 512
	worldPerSec   = 40 // el cliente manda ~15 estados/s
	worldBurst    = 80
)

type worldPlayer struct {
	Pod   int    `json:"pod"`
	Name  string `json:"name"`
	Robot string `json:"robot"`
	Shell string `json:"shell"`
}

// players: quién está en el mundo (con r.mu tomado)
func (r *relay) players() []worldPlayer {
	out := []worldPlayer{}
	for _, rm := range r.rooms {
		if rm.screen != nil && rm.pod >= 0 {
			out = append(out, worldPlayer{rm.pod, rm.ownerName, rm.robotName, rm.shell})
		}
	}
	return out
}

// takePod: la cápsula de la sala, o la primera libre (con r.mu tomado)
func (r *relay) takePod(rm *room) {
	if rm.pod >= 0 {
		return
	}
	used := map[int]bool{}
	for _, o := range r.rooms {
		if o.pod >= 0 {
			used[o.pod] = true
		}
	}
	for _, p := range podOrder {
		if !used[p] {
			rm.pod = p
			return
		}
	}
}

// announceWorld: a cada pantalla, su cápsula y quién está (con r.mu tomado)
func (r *relay) announceWorld() {
	players := r.players()
	for _, rm := range r.rooms {
		if rm.screen != nil {
			trySend(rm.screen, text(map[string]any{"t": "world", "pod": rm.pod, "players": players}))
		}
	}
}

// releasePods: cápsulas de quien no volvió en podGrace (con r.mu tomado; lo llama el janitor)
func (r *relay) releasePods() bool {
	changed := false
	for _, rm := range r.rooms {
		if rm.screen == nil && rm.pod >= 0 && time.Since(rm.screenGone) > podGrace {
			rm.pod = -1
			changed = true
		}
	}
	return changed
}

// ─── Pase firmado ───────────────────────────────────────────────────────────────

type worldPass struct {
	User int64 `json:"u"`
	Pod  int   `json:"p"`
	Exp  int64 `json:"x"`
}

type worldKeys struct {
	secret []byte
	url    string
}

func newWorldKeys() *worldKeys {
	secret := []byte(envOr("NAO_WORLD_SECRET", ""))
	if len(secret) == 0 {
		// Sin secreto compartido solo funciona el plan B (se firma y verifica aquí mismo)
		secret = make([]byte, 32)
		_, _ = rand.Read(secret)
		if envOr("NAO_WORLD_URL", "") != "" {
			log.Println("mundo: NAO_WORLD_URL sin NAO_WORLD_SECRET; la sala de Cloudflare no aceptará los pases")
		}
	}
	return &worldKeys{secret: secret, url: envOr("NAO_WORLD_URL", "")}
}

func (k *worldKeys) sign(p worldPass) string {
	body, _ := json.Marshal(p)
	mac := hmac.New(sha256.New, k.secret)
	mac.Write(body)
	enc := base64.RawURLEncoding
	return enc.EncodeToString(body) + "." + enc.EncodeToString(mac.Sum(nil))
}

func (k *worldKeys) verify(s string) (worldPass, error) {
	var p worldPass
	body64, sig64, ok := strings.Cut(s, ".")
	enc := base64.RawURLEncoding
	body, err1 := enc.DecodeString(body64)
	sig, err2 := enc.DecodeString(sig64)
	if !ok || err1 != nil || err2 != nil {
		return p, errors.New("pase inválido")
	}
	mac := hmac.New(sha256.New, k.secret)
	mac.Write(body)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return p, errors.New("firma inválida")
	}
	if err := json.Unmarshal(body, &p); err != nil || p.Pod < 0 || p.Pod > 255 {
		return p, errors.New("pase inválido")
	}
	if time.Now().Unix() > p.Exp {
		return p, errors.New("pase vencido")
	}
	return p, nil
}

// POST /api/world/pass: pase para entrar a la sala del mundo (solo con la pantalla abierta y una cápsula)
func (r *relay) handleWorldPass(w http.ResponseWriter, req *http.Request) {
	u, err := r.auth.current(req)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	r.mu.Lock()
	pod := -1
	for _, rm := range r.rooms {
		if rm.owner == u.ID && rm.screen != nil {
			pod = rm.pod
		}
	}
	r.mu.Unlock()
	if pod < 0 {
		writeError(w, http.StatusConflict, "entra al mundo primero")
		return
	}
	pass := r.world.sign(worldPass{User: u.ID, Pod: pod, Exp: time.Now().Add(passTTL).Unix()})
	writeJSON(w, http.StatusOK, map[string]any{"pass": pass, "url": r.world.url, "pod": pod})
}

// ─── Plan B: la sala del mundo en nao-api ──────────────────────────────────────

type worldHub struct {
	mu    sync.Mutex
	conns map[int]*conn // cápsula → conexión
	hi    map[int][]byte
}

func newWorldHub() *worldHub { return &worldHub{conns: map[int]*conn{}, hi: map[int][]byte{}} }

func (h *worldHub) broadcast(from int, f frame) {
	for pod, c := range h.conns {
		if pod != from {
			trySend(c, f)
		}
	}
}

// GET /api/world?pass=…
func (r *relay) handleWorldWS(w http.ResponseWriter, req *http.Request) {
	p, err := r.world.verify(req.URL.Query().Get("pass"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	ws, err := r.up.Upgrade(w, req, nil)
	if err != nil {
		return
	}
	c := &conn{ws: ws, send: make(chan frame, sendBufferSize), role: "world"}
	h := r.hub
	h.mu.Lock()
	if old := h.conns[p.Pod]; old != nil {
		closeWith(old, "replaced") // la misma persona desde otra pestaña
	}
	pods := []int{}
	for pod := range h.conns {
		if pod != p.Pod {
			pods = append(pods, pod)
		}
	}
	h.conns[p.Pod] = c
	delete(h.hi, p.Pod)
	trySend(c, text(map[string]any{"t": "peers", "pods": pods}))
	for pod, hi := range h.hi {
		if pod != p.Pod {
			trySend(c, frame{websocket.TextMessage, hi})
		}
	}
	h.broadcast(p.Pod, text(map[string]any{"t": "join", "pod": p.Pod}))
	h.mu.Unlock()
	go c.writeLoop()

	defer func() {
		h.mu.Lock()
		if h.conns[p.Pod] == c {
			delete(h.conns, p.Pod)
			delete(h.hi, p.Pod)
			h.broadcast(p.Pod, text(map[string]any{"t": "leave", "pod": p.Pod}))
		}
		h.mu.Unlock()
		close(c.send)
	}()
	c.ws.SetReadLimit(worldMaxText)
	_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
	c.ws.SetPongHandler(func(string) error { return c.ws.SetReadDeadline(time.Now().Add(pongWait)) })
	tokens := float64(worldBurst)
	last := time.Now()
	for {
		kind, data, err := c.ws.ReadMessage()
		if err != nil {
			return
		}
		_ = c.ws.SetReadDeadline(time.Now().Add(pongWait))
		now := time.Now()
		tokens = min(float64(worldBurst), tokens+now.Sub(last).Seconds()*worldPerSec)
		last = now
		if tokens < 1 {
			continue
		}
		tokens--
		h.mu.Lock()
		if h.conns[p.Pod] != c {
			h.mu.Unlock()
			return
		}
		switch kind {
		case websocket.BinaryMessage:
			if len(data) >= 2 && len(data) <= worldMaxState && data[0] == 1 {
				data[1] = byte(p.Pod)
				h.broadcast(p.Pod, frame{kind, data})
			}
		case websocket.TextMessage:
			if string(data) == "ping" { // como la respuesta automática del Durable Object
				trySend(c, frame{kind, []byte("pong")})
				break
			}
			var m map[string]any
			if json.Unmarshal(data, &m) != nil {
				break
			}
			switch m["t"] {
			case "say": // lo que dice un NAO: se reenvía, no se guarda
				if said, ok := m["text"].(string); ok {
					if len([]rune(said)) > 500 {
						said = string([]rune(said)[:500])
					}
					h.broadcast(p.Pod, text(map[string]any{"t": "say", "pod": p.Pod, "text": said, "voice": m["voice"]}))
				}
			case "hi":
				m["pod"] = p.Pod
				hi := text(m)
				h.hi[p.Pod] = hi.data
				h.broadcast(p.Pod, hi)
			}
		}
		h.mu.Unlock()
	}
}
