package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schemaSQL string

func openDB(ctx context.Context, url string) (*pgxpool.Pool, error) {
	db, err := pgxpool.New(ctx, url)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}

// applySchema ejecuta schema.sql completo (sin argumentos pgx usa el protocolo simple: varias sentencias)
func applySchema(ctx context.Context, db *pgxpool.Pool) error {
	_, err := db.Exec(ctx, schemaSQL)
	return err
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
