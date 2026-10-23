package main

// Cerebro del NAO: conversación por turnos con Gemini y function calling (POST /api/brain).
//
//   - Un turno empieza con lo que dijo o escribió la persona, el estado del robot y una foto pequeña de sus
//     cámaras. Gemini responde con texto (lo que el NAO dice) y/o llamadas a habilidades (prompt.go).
//   - El navegador ejecuta las habilidades con NAOqi y vuelve con sus resultados (y una foto si la pidió): el
//     mismo turno sigue hasta que Gemini ya no pide nada. Así encadena "ve a la caja, empújala, vuelve y siéntate"
//     revisando cada resultado (si se cayó, se levanta).
//   - El turno en curso vive en memoria del servidor (con las firmas de pensamiento que exige Gemini 3): el
//     navegador solo manda resultados, nunca arma el historial. Un turno nuevo del mismo usuario cancela el anterior.
//   - Contexto: los últimos 20 mensajes de la conversación (BD) en texto; las fotos solo viajan en el turno actual.
//   - Cada llamada se cobra con los tokens reales y respeta el tope diario.
//
// Petición:  {turn?, text?, source?, state, image?, results?: [{id, name, response}]}
// Respuesta: {turn, say, calls: [{id, name, args}], done, spentTodayUsd}

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	historyMessages = 20
	maxBrainBody    = 1 << 20
	maxBrainText    = 600
	maxBrainImage   = 400 << 10
	maxBrainState   = 4 << 10
	maxSteps        = 30 // llamadas a Gemini por turno: tope para que un error no gaste en bucle (tareas de brazos piden muchas)
	turnTTL         = 3 * time.Minute
	// Una conversación sigue si su último mensaje tiene menos de esto; si no, empieza otra
	conversationGap = 2 * time.Hour
)

// Dos modelos: cada turno empieza con el de conversación (barato); si pide alguna habilidad, ese paso se repite con el
// de tareas y el turno sigue con él. Razonamiento bajo: el medio pensaba hasta 1 500 tokens por paso y tardaba en actuar.
//
// Modelo de tareas (medido 2026-10-22 con "ve a la caja gris, empújala un metro, vuelve y siéntate", que está detrás:
// gemini-3.8-flash con razonamiento bajo hizo scan → girar 180° → scan → approach → push → volver → sentarse, bien, en
// 5 llamadas y US$0.019, ~3 s por respuesta. Los rápidos (~1.5 s) fallan en la percepción: 3.5-flash-lite se rindió
// sin buscar y 3-flash-preview fue a una caja de cartón diciendo que era "grisácea". 3.8-flash no acepta "minimal".
//
// Precios por millón de tokens (página oficial de precios de Gemini, 2026-10; 3.8-flash sube a 1.50/7.50 el
// 2027-01-01). APPROX: lo leído de caché se cobra al 10% de la entrada.
var brainPrices = map[string][2]float64{
	"gemini-3.5-flash-lite":  {0.30, 2.50},
	"gemini-3-flash-preview": {0.50, 3.00},
	"gemini-3.1-flash-lite":  {0.25, 1.50},
	"gemini-3.8-flash":       {0.75, 3.75},
}

type brainTurn struct {
	mu           sync.Mutex // un paso a la vez
	id           string
	userID       int64
	conversation int64
	system       string
	history      []any // contenidos de la BD (texto)
	contents     []any // el turno actual: usuario, modelo (crudo, con firmas), respuestas de funciones…
	said         []string
	actions      []string
	steps        int
	// task: el turno pasó al modelo de tareas (pidió una habilidad); desde ahí sigue con él
	task    bool
	updated time.Time
}

// brainModel: modelo y nivel de razonamiento de Gemini 3 ("minimal", "low", "medium", "high")
type brainModel struct{ name, thinking string }

type brain struct {
	auth  *auth
	chat  brainModel // conversación (barato y rápido)
	task  brainModel // tareas: moverse, mirar, usar las manos
	mu    sync.Mutex
	turns map[string]*brainTurn
}

func newBrain(a *auth) *brain {
	return &brain{
		auth:  a,
		chat:  brainModel{envOr("NAO_BRAIN_CHAT_MODEL", "gemini-3.5-flash-lite"), envOr("NAO_BRAIN_CHAT_THINKING", "minimal")},
		task:  brainModel{envOr("NAO_BRAIN_MODEL", "gemini-3.8-flash"), envOr("NAO_BRAIN_THINKING", "low")},
		turns: map[string]*brainTurn{},
	}
}

type brainRequest struct {
	Turn   string          `json:"turn"`
	Text   string          `json:"text"`
	Source string          `json:"source"`
	State  json.RawMessage `json:"state"`
	Image  string          `json:"image"`
	// Final: las últimas acciones incluían finish y todas salieron bien: se guardan y el turno termina sin consultar
	Final bool `json:"final"`
	// Solo para experimentos (admin): Fresh cierra la conversación abierta antes de empezar; Variant "sin-metodo" quita
	// del prompt cómo comprobar si algo es su reflejo (condición A de la prueba del espejo, scripts/bench/mirror.js)
	Fresh   bool   `json:"fresh"`
	Variant string `json:"variant"`
	Results []struct {
		ID       string          `json:"id"`
		Name     string          `json:"name"`
		Response json.RawMessage `json:"response"`
	} `json:"results"`
}

type brainCall struct {
	ID   string          `json:"id"`
	Name string          `json:"name"`
	Args json.RawMessage `json:"args"`
}

func (b *brain) handle(w http.ResponseWriter, r *http.Request) {
	u, err := b.auth.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	var req brainRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBrainBody)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "petición inválida")
		return
	}
	if len(req.State) > maxBrainState {
		writeError(w, http.StatusBadRequest, "estado demasiado grande")
		return
	}
	image, err := decodeJPEG(req.Image)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	ctx := r.Context()
	spent, limit, err := spending(ctx, b.auth.db, u.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo consultar el consumo")
		return
	}
	if spent >= limit {
		writeError(w, http.StatusPaymentRequired, "se acabaron los tokens de hoy: vuelven mañana")
		return
	}

	var t *brainTurn
	var parts []any
	if req.Turn == "" {
		text := strings.TrimSpace(req.Text)
		if text == "" || utf8.RuneCountInString(text) > maxBrainText {
			writeError(w, http.StatusBadRequest, "el mensaje debe tener entre 1 y 600 caracteres")
			return
		}
		admin := u.Role == "admin"
		if req.Fresh && admin {
			if _, err := b.auth.db.Exec(ctx, `UPDATE conversations SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL`, u.ID); err != nil {
				log.Printf("cerebro %s: cerrar conversación: %v", u.Username, err)
			}
		}
		selfCheck := !(admin && req.Variant == "sin-metodo")
		if t, err = b.start(ctx, u, text, selfCheck); err != nil {
			log.Printf("cerebro %s: %v", u.Username, err)
			writeError(w, http.StatusInternalServerError, "no se pudo abrir la conversación")
			return
		}
		parts = append(parts, map[string]any{"text": "[estado] " + string(req.State)}, map[string]any{"text": text})
		if image != nil {
			parts = append(parts, map[string]any{"text": "[lo que ves ahora]"}, inlineJPEG(image))
		}
	} else {
		if t = b.get(req.Turn, u.ID); t == nil {
			writeError(w, http.StatusGone, "el turno ya terminó")
			return
		}
		t.mu.Lock()
		defer t.mu.Unlock()
		if len(req.Results) == 0 {
			writeError(w, http.StatusBadRequest, "faltan los resultados")
			return
		}
		for _, res := range req.Results {
			fr := map[string]any{"name": res.Name, "response": json.RawMessage(res.Response)}
			if res.ID != "" {
				fr["id"] = res.ID
			}
			parts = append(parts, map[string]any{"functionResponse": fr})
			t.actions = append(t.actions, summarizeAction(res.Name, res.Response))
		}
		if len(req.State) > 0 {
			parts = append(parts, map[string]any{"text": "[estado] " + string(req.State)})
		}
		if image != nil {
			parts = append(parts, map[string]any{"text": "[foto nueva]"}, inlineJPEG(image))
		}
	}
	t.contents = append(t.contents, map[string]any{"role": "user", "parts": parts})
	if req.Turn != "" && req.Final {
		b.finish(t)
		writeJSON(w, http.StatusOK, map[string]any{"turn": t.id, "say": "", "calls": nil, "done": true, "spentTodayUsd": spent})
		return
	}

	say, calls, spentNow, err := b.step(ctx, u, t)
	if err == nil && !t.task && len(calls) > 0 {
		// El modelo de conversación pidió hacer_tarea: se descarta y el mismo paso lo decide el de tareas, con todas
		// las habilidades (el barato percibe peor: en la prueba de la caja gris se rindió o fue a otra caja)
		t.contents = t.contents[:len(t.contents)-1]
		t.task = true
		say, calls, spentNow, err = b.step(ctx, u, t)
	}
	if err != nil {
		log.Printf("cerebro %s: %v", u.Username, err)
		b.drop(t.id)
		writeError(w, http.StatusBadGateway, "no pude pensar: "+err.Error())
		return
	}
	done := len(calls) == 0
	if !done && t.steps >= maxSteps {
		done, calls = true, nil
		say = strings.TrimSpace(say + " Me detengo aquí: eran demasiados pasos seguidos.")
	}
	if say != "" {
		t.said = append(t.said, say)
	}
	if done {
		b.finish(t)
	}
	writeJSON(w, http.StatusOK, map[string]any{"turn": t.id, "say": say, "calls": calls, "done": done, "spentTodayUsd": spentNow})
}

// start: turno nuevo (cancela el anterior del mismo usuario) con la conversación vigente y su historial
func (b *brain) start(ctx context.Context, u *user, text string, selfCheck bool) (*brainTurn, error) {
	db := b.auth.db
	var conv int64
	err := db.QueryRow(ctx, `
		SELECT c.id FROM conversations c
		WHERE c.user_id = $1 AND c.ended_at IS NULL
		  AND COALESCE((SELECT max(created_at) FROM messages WHERE conversation_id = c.id), c.started_at) > now() - $2::interval
		ORDER BY c.started_at DESC LIMIT 1`, u.ID, fmt.Sprintf("%d seconds", int(conversationGap.Seconds()))).Scan(&conv)
	if err != nil {
		if err := db.QueryRow(ctx, `INSERT INTO conversations (user_id) VALUES ($1) RETURNING id`, u.ID).Scan(&conv); err != nil {
			return nil, err
		}
	}
	rows, err := db.Query(ctx, `
		SELECT speaker, text FROM (
		  SELECT id, speaker, text FROM messages WHERE conversation_id = $1 AND speaker IN ('user', 'nao')
		  ORDER BY id DESC LIMIT $2) m ORDER BY id`, conv, historyMessages)
	if err != nil {
		return nil, err
	}
	var history []any
	for rows.Next() {
		var speaker, msg string
		if err := rows.Scan(&speaker, &msg); err != nil {
			rows.Close()
			return nil, err
		}
		role := "user"
		if speaker == "nao" {
			role = "model"
		}
		history = append(history, map[string]any{"role": role, "parts": []any{map[string]any{"text": msg}}})
	}
	rows.Close()
	if _, err := db.Exec(ctx, `INSERT INTO messages (conversation_id, speaker, text) VALUES ($1, 'user', $2)`, conv, text); err != nil {
		return nil, err
	}

	buf := make([]byte, 12)
	_, _ = rand.Read(buf)
	t := &brainTurn{
		id: base64.RawURLEncoding.EncodeToString(buf), userID: u.ID, conversation: conv,
		system: systemPrompt(u, selfCheck), history: history, updated: time.Now(),
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for id, old := range b.turns {
		if old.userID == u.ID || time.Since(old.updated) > turnTTL {
			delete(b.turns, id)
		}
	}
	b.turns[t.id] = t
	return t, nil
}

func (b *brain) get(id string, userID int64) *brainTurn {
	b.mu.Lock()
	defer b.mu.Unlock()
	t := b.turns[id]
	if t == nil || t.userID != userID || time.Since(t.updated) > turnTTL {
		return nil
	}
	t.updated = time.Now()
	return t
}

func (b *brain) drop(id string) {
	b.mu.Lock()
	delete(b.turns, id)
	b.mu.Unlock()
}

// finish guarda lo que dijo el NAO (con un resumen de lo que hizo, para que lo recuerde en los próximos turnos)
func (b *brain) finish(t *brainTurn) {
	b.drop(t.id)
	text := strings.Join(t.said, " ")
	if len(t.actions) > 0 {
		text = strings.TrimSpace(text + " [hice: " + strings.Join(t.actions, ", ") + "]")
	}
	if text == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := b.auth.db.Exec(ctx, `INSERT INTO messages (conversation_id, speaker, text) VALUES ($1, 'nao', $2)`, t.conversation, text); err != nil {
		log.Printf("cerebro: no se pudo guardar la respuesta: %v", err)
	}
}

type geminiPart struct {
	Text         string     `json:"text"`
	Thought      bool       `json:"thought"`
	FunctionCall *brainCall `json:"functionCall"`
}

// step: una llamada a Gemini con todo el contexto; devuelve lo que dice el NAO y las habilidades que pide
func (b *brain) step(ctx context.Context, u *user, t *brainTurn) (string, []brainCall, float64, error) {
	t.steps++
	m := b.chat
	if t.task {
		m = b.task
	}
	contents := append(append([]any{}, t.history...), latestImageOnly(t.contents)...)
	gen := map[string]any{"mediaResolution": "MEDIA_RESOLUTION_LOW", "temperature": 0.7}
	if m.thinking != "" {
		gen["thinkingConfig"] = map[string]any{"thinkingLevel": m.thinking}
	}
	system, tools := t.system, brainTools
	if !t.task {
		system, tools = t.system+chatRule, chatTools
	}
	payload := map[string]any{
		"systemInstruction": map[string]any{"parts": []any{map[string]any{"text": system}}},
		"contents":          contents,
		"tools":             tools,
		"generationConfig":  gen,
	}
	if !t.task {
		// Elegir sí o sí responder o hacer_tarea: sin texto suelto que prometa algo sin hacerlo
		payload["toolConfig"] = map[string]any{"functionCallingConfig": map[string]any{"mode": "ANY"}}
	}
	callCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	raw, err := geminiPost(callCtx, m.name+":generateContent", payload)
	if err != nil {
		return "", nil, 0, err
	}
	var parsed struct {
		Candidates []struct {
			Content      json.RawMessage `json:"content"`
			FinishReason string          `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount        int `json:"promptTokenCount"`
			CandidatesTokenCount    int `json:"candidatesTokenCount"`
			ThoughtsTokenCount      int `json:"thoughtsTokenCount"`
			CachedContentTokenCount int `json:"cachedContentTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", nil, 0, err
	}
	um := parsed.UsageMetadata
	price, ok := brainPrices[m.name]
	if !ok {
		price = brainPrices["gemini-3.8-flash"]
	}
	out := um.CandidatesTokenCount + um.ThoughtsTokenCount
	cost := (float64(um.PromptTokenCount-um.CachedContentTokenCount)+0.1*float64(um.CachedContentTokenCount))*price[0]/1e6 +
		float64(out)*price[1]/1e6
	chargeCtx, cancelCharge := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelCharge()
	spent, err := charge(chargeCtx, b.auth.db, u.ID, usage{
		Feature: "conversacion", Model: m.name, InputTokens: um.PromptTokenCount, OutputTokens: out, CostUSD: cost,
	})
	if err != nil {
		log.Printf("cerebro %s: no se pudo registrar el consumo: %v", u.Username, err)
	}
	log.Printf("cerebro %s: paso %d %s · %d tokens de entrada (%d en caché), %d de salida · US$%.6f",
		u.Username, t.steps, m.name, um.PromptTokenCount, um.CachedContentTokenCount, out, cost)

	if len(parsed.Candidates) == 0 || len(parsed.Candidates[0].Content) == 0 {
		return "", nil, spent, errors.New("Gemini no respondió nada")
	}
	content := parsed.Candidates[0].Content
	var c struct {
		Parts []geminiPart `json:"parts"`
	}
	if err := json.Unmarshal(content, &c); err != nil {
		return "", nil, spent, err
	}
	// El contenido del modelo vuelve tal cual (con thoughtSignature) en la siguiente llamada del turno
	t.contents = append(t.contents, content)
	var say strings.Builder
	var calls []brainCall
	for i, p := range c.Parts {
		switch {
		case p.FunctionCall != nil:
			call := *p.FunctionCall
			if call.ID == "" {
				call.ID = "c" + strconv.Itoa(t.steps) + "_" + strconv.Itoa(i)
			}
			if len(call.Args) == 0 {
				call.Args = json.RawMessage(`{}`)
			}
			calls = append(calls, call)
		case p.Text != "" && !p.Thought:
			say.WriteString(p.Text)
		}
	}
	// Modo conversación: "responder" es solo la forma obligada de hablar, no una habilidad del navegador
	if !t.task {
		for i := 0; i < len(calls); i++ {
			if calls[i].Name == "responder" {
				var a struct {
					Texto string `json:"texto"`
				}
				_ = json.Unmarshal(calls[i].Args, &a)
				say.WriteString(a.Texto)
				calls = append(calls[:i], calls[i+1:]...)
				i--
			}
		}
	}
	return strings.TrimSpace(say.String()), calls, spent, nil
}

// latestImageOnly: copia del turno con solo la última foto; las anteriores se cambian por una nota. Cada paso reenvía
// todo el turno y las fotos viejas eran casi toda la entrada (tumbar la caja: 30 pasos, 13 000 tokens el último).
func latestImageOnly(contents []any) []any {
	last := -1
	for i, c := range contents {
		if m, ok := c.(map[string]any); ok {
			for _, p := range m["parts"].([]any) {
				if pm, ok := p.(map[string]any); ok && pm["inline_data"] != nil {
					last = i
				}
			}
		}
	}
	out := make([]any, len(contents))
	for i, c := range contents {
		m, ok := c.(map[string]any)
		if !ok || i == last {
			out[i] = c
			continue
		}
		parts := m["parts"].([]any)
		pruned := make([]any, len(parts))
		for k, p := range parts {
			if pm, ok := p.(map[string]any); ok && pm["inline_data"] != nil {
				pruned[k] = map[string]any{"text": "(foto anterior, ya no se envía)"}
			} else {
				pruned[k] = p
			}
		}
		out[i] = map[string]any{"role": m["role"], "parts": pruned}
	}
	return out
}

func decodeJPEG(dataURL string) ([]byte, error) {
	if dataURL == "" {
		return nil, nil
	}
	b64, ok := strings.CutPrefix(dataURL, "data:image/jpeg;base64,")
	if !ok {
		return nil, errors.New("la foto debe ser JPEG")
	}
	data, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return nil, errors.New("foto inválida")
	}
	if len(data) > maxBrainImage {
		return nil, errors.New("foto demasiado grande")
	}
	return data, nil
}

func inlineJPEG(data []byte) map[string]any {
	return map[string]any{"inline_data": map[string]string{"mime_type": "image/jpeg", "data": base64.StdEncoding.EncodeToString(data)}}
}

// summarizeAction: "push ✓" o "approach ✗" según el campo ok del resultado
func summarizeAction(name string, response json.RawMessage) string {
	var r struct {
		OK *bool `json:"ok"`
	}
	_ = json.Unmarshal(response, &r)
	switch {
	case r.OK == nil:
		return name
	case *r.OK:
		return name + " ✓"
	default:
		return name + " ✗"
	}
}
