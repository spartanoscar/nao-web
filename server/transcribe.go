package main

// Transcripción en tiempo real de lo que se le habla al teléfono. Patrón de Juntox
// (ubuntu-services/asm-transcriber/core.py), sin LiveKit: el audio llega por la sala del QR.
//
//   - Gemini Live con el modelo de transcripción y la detección de voz de Gemini apagada: el teléfono detecta
//     cuándo se habla y solo manda ese audio, con inicio/fin (activityStart/activityEnd). El silencio no se envía
//     ni se paga.
//   - Sesión perezosa: se abre al empezar a hablar, se cierra tras 40 s sin audio (Gemini corta a los ~60 s) y se
//     renueva antes de los 10 min (límite de una sesión, sin reanudación).
//   - Gemini cierra un texto ("final") en SUS pausas, no en nuestro fin de voz: cada final corresponde al tramo
//     de audio desde el final anterior.
//   - Cada tramo hablado se cobra al dueño de la sala por segundo de audio y se respeta su tope diario.
//
// Del teléfono (binario, no se reenvía a la pantalla): [1] inicio de voz · [2]+PCM16 LE 16 kHz mono · [3] fin.
// A la pantalla y al teléfono (JSON): {t:'caption', id, text, final} · {t:'usage', spentTodayUsd} ·
// {t:'caption-error', error}.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

const (
	geminiLiveURL  = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
	sampleRate     = 16000
	sessionMax     = 9 * time.Minute
	sessionIdle    = 40 * time.Second
	setupTimeout   = 10 * time.Second
	audioQueueSize = 512

	frameStart = 1
	frameAudio = 2
	frameEnd   = 3
)

// APPROX: precio medido en un proyecto anterior (Juntox) y de los listados de precios de 2026-10: ~US$3.5/1M tokens
// de audio de entrada + US$21/1M de texto de salida ≈ US$0.009 por minuto hablado. NAO_TRANSCRIBE_USD_PER_MIN lo
// cambia; ai_usage_log guarda además los tokens que reporte Gemini para comparar.
const defaultUSDPerMinute = 0.009

type transcriber struct {
	relay  *relay
	code   string
	userID int64
	key    string
	model  string
	perMin float64
	frames chan []byte

	ws       *websocket.Conn
	alive    atomic.Bool // el lector de la sesión sigue vivo (Gemini puede cortarla por su lado)
	wmu      sync.Mutex  // escrituras al socket de Gemini
	opened   time.Time
	lastUsed time.Time
	speaking bool

	mu        sync.Mutex // estado compartido con el lector
	line      int        // id del renglón de subtítulo en curso (cambia con cada final)
	spanAudio float64    // segundos de audio del tramo en curso (desde el último final)
	tokensIn  int
	tokensOut int
}

func newTranscriber(r *relay, code string, userID int64) *transcriber {
	t := &transcriber{
		relay:  r,
		code:   code,
		userID: userID,
		key:    envOr("GEMINI_API_KEY", ""),
		model:  envOr("NAO_TRANSCRIBE_MODEL", "gemini-3.5-transcribe-live"),
		perMin: defaultUSDPerMinute,
		frames: make(chan []byte, audioQueueSize),
		line:   int(time.Now().UnixMilli()), // ids únicos aunque el teléfono se reconecte
	}
	if v, err := strconv.ParseFloat(envOr("NAO_TRANSCRIBE_USD_PER_MIN", ""), 64); err == nil && v > 0 {
		t.perMin = v
	}
	go t.run()
	return t
}

// push no bloquea el lector del teléfono: si la cola se llena, se pierde audio (mejor que frenar la sala)
func (t *transcriber) push(frame []byte) {
	defer func() { _ = recover() }() // cola cerrada
	select {
	case t.frames <- frame:
	default:
	}
}

func (t *transcriber) stop() {
	defer func() { _ = recover() }()
	close(t.frames)
}

func (t *transcriber) run() {
	idle := time.NewTicker(5 * time.Second)
	defer func() {
		idle.Stop()
		t.closeSession()
	}()
	for {
		select {
		case f, ok := <-t.frames:
			if !ok {
				return
			}
			t.handle(f)
		case <-idle.C:
			if t.ws != nil && !t.speaking && time.Since(t.lastUsed) > sessionIdle {
				t.closeSession()
			}
		}
	}
}

func (t *transcriber) handle(f []byte) {
	switch f[0] {
	case frameStart:
		if err := t.startTurn(); err != nil {
			log.Printf("transcripción %s: %v", t.code, err)
			t.relay.toRoom(t.code, text(map[string]any{"t": "caption-error", "error": err.Error()}))
		}
	case frameAudio:
		if !t.speaking || t.ws == nil || !t.alive.Load() || len(f) < 3 {
			return
		}
		pcm := f[1:]
		t.mu.Lock()
		t.spanAudio += float64(len(pcm)) / 2 / sampleRate
		t.mu.Unlock()
		t.send(map[string]any{"realtimeInput": map[string]any{"audio": map[string]string{
			"data": base64.StdEncoding.EncodeToString(pcm), "mimeType": "audio/pcm;rate=16000",
		}}})
	case frameEnd:
		if !t.speaking {
			return
		}
		t.speaking = false
		t.lastUsed = time.Now()
		t.send(map[string]any{"realtimeInput": map[string]any{"activityEnd": map[string]any{}}})
	}
}

func (t *transcriber) startTurn() error {
	if t.key == "" {
		return errors.New("la transcripción no está configurada: falta la clave de Gemini en el servidor")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	spent, limit, err := spending(ctx, t.relay.auth.db, t.userID)
	if err != nil {
		return errors.New("no se pudo consultar el consumo")
	}
	if spent >= limit {
		return errors.New("se acabaron los tokens de hoy: vuelven mañana")
	}
	if t.ws != nil && (!t.alive.Load() || time.Since(t.opened) > sessionMax || time.Since(t.lastUsed) > sessionIdle) {
		t.closeSession()
	}
	if t.ws == nil {
		if err := t.openSession(); err != nil {
			return err
		}
	}
	t.speaking = true
	t.lastUsed = time.Now()
	t.send(map[string]any{"realtimeInput": map[string]any{"activityStart": map[string]any{}}})
	return nil
}

func (t *transcriber) openSession() error {
	ws, _, err := websocket.DefaultDialer.Dial(geminiLiveURL+"?key="+t.key, nil)
	if err != nil {
		return errors.New("no se pudo conectar con Gemini")
	}
	setup := map[string]any{"setup": map[string]any{
		"model":               "models/" + t.model,
		"generationConfig":    map[string]any{"responseModalities": []string{"TEXT"}},
		"realtimeInputConfig": map[string]any{"automaticActivityDetection": map[string]any{"disabled": true}},
		"inputAudioTranscription": map[string]any{
			"languageCodes":    []string{"es-CO"},
			"customVocabulary": []string{"NAO", "Libertadores", "NAOqi"},
			"mode":             "VERBATIM",
		},
	}}
	if err := ws.WriteJSON(setup); err != nil {
		ws.Close()
		return errors.New("Gemini rechazó la conexión")
	}
	_ = ws.SetReadDeadline(time.Now().Add(setupTimeout))
	var first map[string]json.RawMessage
	if err := ws.ReadJSON(&first); err != nil || first["setupComplete"] == nil {
		ws.Close()
		log.Printf("transcripción %s: setup rechazado: %v %s", t.code, err, truncate(string(first["error"]), 300))
		return errors.New("Gemini no aceptó la sesión de transcripción")
	}
	_ = ws.SetReadDeadline(time.Time{})
	t.ws = ws
	t.opened = time.Now()
	t.alive.Store(true)
	go t.read(ws)
	return nil
}

func (t *transcriber) closeSession() {
	if t.ws == nil {
		return
	}
	t.flushCharge() // el audio enviado se paga aunque no haya llegado su final
	t.wmu.Lock()
	_ = t.ws.Close()
	t.wmu.Unlock()
	t.ws = nil
	t.speaking = false
}

func (t *transcriber) send(v any) {
	t.wmu.Lock()
	defer t.wmu.Unlock()
	if t.ws == nil {
		return
	}
	_ = t.ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
	if err := t.ws.WriteJSON(v); err != nil {
		log.Printf("transcripción %s: envío falló: %v", t.code, err)
	}
}

type liveMessage struct {
	ServerContent *struct {
		Interim *struct{ Text string } `json:"interimInputTranscription"`
		Final   *struct{ Text string } `json:"inputTranscription"`
	} `json:"serverContent"`
	UsageMetadata *struct {
		PromptTokenCount   int `json:"promptTokenCount"`
		ResponseTokenCount int `json:"responseTokenCount"`
	} `json:"usageMetadata"`
	GoAway json.RawMessage `json:"goAway"`
}

// read: subtítulos parciales y finales hacia la sala; al cerrar un final se cobra su tramo
func (t *transcriber) read(ws *websocket.Conn) {
	defer t.alive.Store(false)
	for {
		var m liveMessage
		if err := ws.ReadJSON(&m); err != nil {
			return
		}
		if m.UsageMetadata != nil {
			t.mu.Lock()
			t.tokensIn += m.UsageMetadata.PromptTokenCount
			t.tokensOut += m.UsageMetadata.ResponseTokenCount
			t.mu.Unlock()
		}
		if m.ServerContent == nil {
			continue
		}
		t.mu.Lock()
		line := t.line
		t.mu.Unlock()
		if m.ServerContent.Interim != nil && m.ServerContent.Interim.Text != "" {
			t.relay.toRoom(t.code, text(map[string]any{"t": "caption", "id": line, "text": m.ServerContent.Interim.Text, "final": false}))
		}
		if m.ServerContent.Final != nil {
			t.mu.Lock()
			t.line++
			t.mu.Unlock()
			if s := m.ServerContent.Final.Text; s != "" {
				t.relay.toRoom(t.code, text(map[string]any{"t": "caption", "id": line, "text": s, "final": true}))
			}
			t.flushCharge()
		}
	}
}

// flushCharge cobra el audio acumulado desde el último cobro y avisa el gasto nuevo a la sala
func (t *transcriber) flushCharge() {
	t.mu.Lock()
	sec, in, out := t.spanAudio, t.tokensIn, t.tokensOut
	t.spanAudio, t.tokensIn, t.tokensOut = 0, 0, 0
	t.mu.Unlock()
	if sec <= 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	spent, err := charge(ctx, t.relay.auth.db, t.userID, usage{
		Feature: "transcripcion", Model: t.model, AudioSeconds: sec, InputTokens: in, OutputTokens: out,
		CostUSD: sec / 60 * t.perMin,
	})
	if err != nil {
		log.Printf("transcripción %s: no se pudo registrar el consumo: %v", t.code, err)
		return
	}
	t.relay.toRoom(t.code, text(map[string]any{"t": "usage", "spentTodayUsd": spent}))
}
