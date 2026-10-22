package main

// Control de costos (patrón de Rondax): cada uso de IA se registra con su costo real en ai_usage_log y se suma
// al gasto del día (ai_daily_spending, día de America/Bogota). Antes de cada uso se valida el tope diario.

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

type usage struct {
	Feature      string
	Model        string
	AudioSeconds float64
	InputTokens  int
	OutputTokens int
	CostUSD      float64
}

const today = `(now() AT TIME ZONE '` + costTimeZone + `')::date`

// spending: gasto del día y tope del usuario
func spending(ctx context.Context, db *pgxpool.Pool, userID int64) (spent, limit float64, err error) {
	err = db.QueryRow(ctx, `
		SELECT COALESCE((SELECT total_usd FROM ai_daily_spending WHERE user_id = u.id AND day = `+today+`), 0)::float8,
		       u.daily_limit_usd::float8
		FROM users u WHERE u.id = $1`, userID).Scan(&spent, &limit)
	return
}

// charge registra un uso y devuelve el gasto acumulado del día
func charge(ctx context.Context, db *pgxpool.Pool, userID int64, u usage) (float64, error) {
	tx, err := db.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `
		INSERT INTO ai_usage_log (user_id, feature, model, input_tokens, output_tokens, audio_seconds, cost_usd)
		VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		userID, u.Feature, u.Model, u.InputTokens, u.OutputTokens, u.AudioSeconds, u.CostUSD); err != nil {
		return 0, err
	}
	var spent float64
	if err := tx.QueryRow(ctx, `
		INSERT INTO ai_daily_spending (user_id, day, total_usd, calls) VALUES ($1, `+today+`, $2, 1)
		ON CONFLICT (user_id, day) DO UPDATE
		  SET total_usd = ai_daily_spending.total_usd + EXCLUDED.total_usd, calls = ai_daily_spending.calls + 1
		RETURNING total_usd::float8`, userID, u.CostUSD).Scan(&spent); err != nil {
		return 0, err
	}
	return spent, tx.Commit(ctx)
}
