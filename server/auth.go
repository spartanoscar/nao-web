package main

// Login de usuarios registrados (no hay registro abierto).
//
//   - Contraseña con bcrypt. Si el usuario no existe se compara igual contra un hash de relleno: la respuesta
//     tarda lo mismo y no revela qué usuarios existen.
//   - Sesión: token aleatorio de 32 bytes en la cookie `nao_session` (HttpOnly, SameSite=Lax, Secure en HTTPS);
//     en la base solo su SHA-256. Dura 30 días.
//   - Fuerza bruta: 8 intentos fallidos en 15 min por IP o por usuario bloquean 15 min (en memoria, como el
//     lockout de releasenotes en Rondax). La IP real llega en X-Real-IP desde nginx.
//   - Demo: POST /api/auth/demo entra sin contraseña a la cuenta compartida de rol 'demo' (`user add demo … -role demo
//     -limit 0.025`: su tope es el de todos los visitantes juntos). Cada visita es una sesión de 1 día con su propia
//     sala, cápsula y conversación (`user.visit`) y no guarda nada de lo suyo (`demoReadOnly`). 20 visitas por IP
//     cada 15 min.

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

const (
	cookieName     = "nao_session"
	sessionTTL     = 30 * 24 * time.Hour
	failWindow     = 15 * time.Minute
	maxFailures    = 8
	touchEvery     = 5 * time.Minute // last_seen_at no se actualiza en cada petición
	costTimeZone   = "America/Bogota"
	bcryptCost     = 12
	maxLoginBody   = 4 << 10
	maxUsernameLen = 64
	demoSessionTTL = 24 * time.Hour
	maxDemoVisits  = 20 // por IP cada failWindow
	demoReadOnly   = "en la demo no se guardan cambios"
)

type user struct {
	ID            int64   `json:"-"`
	Username      string  `json:"username"`
	DisplayName   string  `json:"displayName"`
	Role          string  `json:"role"`
	RobotName     string  `json:"robotName"`
	DailyLimitUSD float64 `json:"dailyLimitUsd"`
	SpentTodayUSD float64 `json:"spentTodayUsd"`
	Prompt        string  `json:"prompt"`
	// AvatarURL: "/api/avatar?v=<ms>" si tiene foto (la versión cambia con cada foto nueva), "" si no
	AvatarURL string `json:"avatarUrl"`
	// Apariencia de su NAO: "#rrggbb" o "" (la original)
	ShellColor string `json:"shellColor"`
	EyeColor   string `json:"eyeColor"`
	session    []byte // SHA-256 del token de la sesión con la que llegó
}

// demo: la cuenta compartida de la demo
func (u *user) demo() bool { return u.Role == "demo" }

// visit: de quién son la sala, la cápsula y los turnos: "" = del usuario; en la demo, de cada sesión (varias personas
// a la vez no se quitan la sala ni la conversación)
func (u *user) visit() string {
	if u.demo() {
		return hex.EncodeToString(u.session)
	}
	return ""
}

type auth struct {
	db       *pgxpool.Pool
	mu       sync.Mutex
	failures map[string][]time.Time // "ip:…" o "user:…" → intentos fallidos recientes; "demo:<ip>" → visitas a la demo
	dummy    []byte
}

func newAuth(db *pgxpool.Pool) *auth {
	dummy, _ := bcrypt.GenerateFromPassword([]byte("relleno-para-igualar-tiempos"), bcryptCost)
	return &auth{db: db, failures: map[string][]time.Time{}, dummy: dummy}
}

func (a *auth) handleLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxLoginBody)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "petición inválida")
		return
	}
	username := strings.ToLower(strings.TrimSpace(body.Username))
	if username == "" || body.Password == "" || len(username) > maxUsernameLen {
		writeError(w, http.StatusBadRequest, "escribe tu usuario y tu contraseña")
		return
	}
	ip := clientIP(r)
	if wait := a.blocked("ip:"+ip, "user:"+username); wait > 0 {
		writeError(w, http.StatusTooManyRequests, "demasiados intentos; espera "+wait.Round(time.Minute).String())
		return
	}

	var id int64
	var hash string
	var disabled bool
	err := a.db.QueryRow(r.Context(), `SELECT id, password_hash, disabled FROM users WHERE username = $1`, username).Scan(&id, &hash, &disabled)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword(a.dummy, []byte(body.Password))
		a.fail("ip:"+ip, "user:"+username)
		writeError(w, http.StatusUnauthorized, "usuario o contraseña incorrectos")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "error de base de datos")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(body.Password)) != nil || disabled {
		a.fail("ip:"+ip, "user:"+username)
		writeError(w, http.StatusUnauthorized, "usuario o contraseña incorrectos")
		return
	}
	a.clear("user:" + username)
	a.startSession(w, r, id, sessionTTL)
}

// POST /api/auth/demo: entra a la cuenta demo sin contraseña (ver arriba)
func (a *auth) handleDemo(w http.ResponseWriter, r *http.Request) {
	if !a.demoAllowed(clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "demasiadas visitas seguidas; espera unos minutos")
		return
	}
	var id int64
	err := a.db.QueryRow(r.Context(), `SELECT id FROM users WHERE role = 'demo' AND NOT disabled ORDER BY id LIMIT 1`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "la demo no está disponible")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "error de base de datos")
		return
	}
	// Cada visita deja una sesión: aquí se barren las vencidas de todos
	_, _ = a.db.Exec(r.Context(), `DELETE FROM sessions WHERE expires_at < now()`)
	a.startSession(w, r, id, demoSessionTTL)
}

// startSession: crea la sesión, pone la cookie y responde con el usuario
func (a *auth) startSession(w http.ResponseWriter, r *http.Request, id int64, ttl time.Duration) {
	token := make([]byte, 32)
	if _, err := rand.Read(token); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo crear la sesión")
		return
	}
	sum := sha256.Sum256(token)
	expires := time.Now().Add(ttl)
	if _, err := a.db.Exec(r.Context(),
		`INSERT INTO sessions (token_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
		sum[:], id, expires, clientIP(r), truncate(r.UserAgent(), 300)); err != nil {
		writeError(w, http.StatusInternalServerError, "no se pudo crear la sesión")
		return
	}
	_, _ = a.db.Exec(r.Context(), `UPDATE users SET last_login_at = now() WHERE id = $1`, id)
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    base64.RawURLEncoding.EncodeToString(token),
		Path:     "/",
		Expires:  expires,
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
	})
	u, err := a.loadUser(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "error de base de datos")
		return
	}
	u.session = sum[:]
	writeJSON(w, http.StatusOK, u)
}

func (a *auth) handleLogout(w http.ResponseWriter, r *http.Request) {
	if hash, ok := cookieHash(r); ok {
		_, _ = a.db.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash = $1`, hash)
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: isHTTPS(r), SameSite: http.SameSiteLaxMode})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *auth) handleMe(w http.ResponseWriter, r *http.Request) {
	u, err := a.current(r)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "inicia sesión")
		return
	}
	writeJSON(w, http.StatusOK, u)
}

// current: el usuario de la cookie de sesión (vigente y no deshabilitado)
func (a *auth) current(r *http.Request) (*user, error) {
	hash, ok := cookieHash(r)
	if !ok {
		return nil, errors.New("sin sesión")
	}
	var id int64
	var lastSeen time.Time
	err := a.db.QueryRow(r.Context(), `
		SELECT s.user_id, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled`, hash).Scan(&id, &lastSeen)
	if err != nil {
		return nil, err
	}
	if time.Since(lastSeen) > touchEvery {
		_, _ = a.db.Exec(r.Context(), `UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1`, hash)
	}
	u, err := a.loadUser(r.Context(), id)
	if err != nil {
		return nil, err
	}
	u.session = hash
	return u, nil
}

func (a *auth) loadUser(ctx context.Context, id int64) (*user, error) {
	u := &user{ID: id}
	var robot *string
	var avatarAt *time.Time
	err := a.db.QueryRow(ctx, `
		SELECT u.username, u.display_name, u.role, u.robot_name, u.daily_limit_usd::float8,
		       COALESCE((SELECT d.total_usd FROM ai_daily_spending d
		                 WHERE d.user_id = u.id AND d.day = (now() AT TIME ZONE '`+costTimeZone+`')::date), 0)::float8,
		       u.prompt, CASE WHEN u.avatar IS NULL THEN NULL ELSE u.avatar_updated_at END,
		       COALESCE(u.shell_color, ''), COALESCE(u.eye_color, '')
		FROM users u WHERE u.id = $1`, id).Scan(&u.Username, &u.DisplayName, &u.Role, &robot, &u.DailyLimitUSD, &u.SpentTodayUSD,
		&u.Prompt, &avatarAt, &u.ShellColor, &u.EyeColor)
	if err != nil {
		return nil, err
	}
	if avatarAt != nil {
		u.AvatarURL = "/api/avatar?v=" + strconv.FormatInt(avatarAt.UnixMilli(), 10)
	}
	u.RobotName = "NAO"
	if robot != nil && *robot != "" {
		u.RobotName = *robot
	}
	return u, nil
}

// ─── Fuerza bruta ─────────────────────────────────────────────────────────────

func (a *auth) blocked(keys ...string) time.Duration {
	a.mu.Lock()
	defer a.mu.Unlock()
	var wait time.Duration
	for _, k := range keys {
		recent := a.prune(k)
		if len(recent) >= maxFailures {
			wait = max(wait, failWindow-time.Since(recent[0]))
		}
	}
	return wait
}

func (a *auth) fail(keys ...string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, k := range keys {
		a.failures[k] = append(a.prune(k), time.Now())
	}
}

// demoAllowed: cuenta la visita de esa IP a la demo; false si ya van maxDemoVisits en la ventana
func (a *auth) demoAllowed(ip string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	key := "demo:" + ip
	recent := a.prune(key)
	if len(recent) >= maxDemoVisits {
		return false
	}
	a.failures[key] = append(recent, time.Now())
	return true
}

func (a *auth) clear(key string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.failures, key)
}

// prune: intentos dentro de la ventana (con a.mu tomado)
func (a *auth) prune(key string) []time.Time {
	list := a.failures[key]
	i := 0
	for i < len(list) && time.Since(list[i]) > failWindow {
		i++
	}
	list = list[i:]
	if len(list) == 0 {
		delete(a.failures, key)
	} else {
		a.failures[key] = list
	}
	return list
}

// ─── Utilidades ───────────────────────────────────────────────────────────────

func cookieHash(r *http.Request) ([]byte, bool) {
	c, err := r.Cookie(cookieName)
	if err != nil {
		return nil, false
	}
	token, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil || len(token) != 32 {
		return nil, false
	}
	sum := sha256.Sum256(token)
	return sum[:], true
}

// clientIP: nginx pone X-Real-IP (ya resuelta desde CF-Connecting-IP); en local, la del socket
func clientIP(r *http.Request) string {
	if ip := strings.TrimSpace(r.Header.Get("X-Real-IP")); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func isHTTPS(r *http.Request) bool {
	return r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
