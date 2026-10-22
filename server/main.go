// nao-api: servidor de NAO Web (https://nao.bukivo.com, detrás de nginx en /api).
//
//   - Login solo para usuarios registrados: contraseña bcrypt y sesión en cookie HttpOnly (auth.go).
//   - Sala del teléfono por QR: relay WebSocket entre el escritorio y el móvil (relay.go, patrón de hv).
//   - Base de datos PostgreSQL (schema.sql): usuarios, sesiones, control de costos, conversaciones, rostros…
//
// Subcomandos:
//
//	nao-api                      servidor (NAO_ADDR, por defecto 127.0.0.1:3030)
//	nao-api migrate              aplica schema.sql
//	nao-api user add <usuario> <nombre> [-role admin|teacher|student] [-limit 2] [-robot NOMBRE]
//	nao-api user passwd <usuario>
//	nao-api user list
//
// Configuración por entorno (o NAO_ENV_FILE / ./.env): NAO_DB_URL, NAO_ADDR, NAO_ALLOWED_ORIGINS.
package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

func main() {
	loadEnvFile()
	ctx := context.Background()
	db, err := openDB(ctx, mustEnv("NAO_DB_URL"))
	if err != nil {
		log.Fatalf("base de datos: %v", err)
	}
	defer db.Close()

	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "migrate":
			if err := applySchema(ctx, db); err != nil {
				log.Fatalf("migrate: %v", err)
			}
			log.Println("esquema aplicado")
			return
		case "user":
			userCommand(ctx, db, os.Args[2:])
			return
		default:
			log.Fatalf("subcomando desconocido %q (migrate, user)", os.Args[1])
		}
	}

	if err := applySchema(ctx, db); err != nil {
		log.Fatalf("esquema: %v", err)
	}
	auth := newAuth(db)
	relay := newRelay(auth)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, http.StatusOK, map[string]bool{"ok": true}) })
	mux.HandleFunc("POST /api/auth/login", auth.handleLogin)
	mux.HandleFunc("POST /api/auth/logout", auth.handleLogout)
	mux.HandleFunc("GET /api/me", auth.handleMe)
	mux.HandleFunc("POST /api/rooms", relay.handleCreateRoom)
	mux.HandleFunc("GET /api/ws", relay.handleWS)

	addr := envOr("NAO_ADDR", "127.0.0.1:3030")
	srv := &http.Server{
		Addr:              addr,
		Handler:           securityHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("nao-api escuchando en %s", addr)
	log.Fatal(srv.ListenAndServe())
}

// securityHeaders: la API solo responde JSON a sus propias páginas (mismo origen, sin CORS)
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "no-store")
		next.ServeHTTP(w, r)
	})
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("falta la variable de entorno %s", key)
	}
	return v
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// loadEnvFile lee KEY=VALOR de NAO_ENV_FILE (o ./.env) sin pisar lo que ya venga del entorno
func loadEnvFile() {
	path := envOr("NAO_ENV_FILE", ".env")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.Trim(strings.TrimSpace(v), `"'`)
		if os.Getenv(k) == "" {
			_ = os.Setenv(k, v)
		}
	}
}
