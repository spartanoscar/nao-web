package main

// Administración de usuarios por consola (no hay registro abierto: solo entran los que se crean aquí).
// La contraseña se genera al azar y se muestra una sola vez; en la base queda solo el hash bcrypt.

import (
	"context"
	"crypto/rand"
	"flag"
	"fmt"
	"log"
	"math/big"
	"os"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

// Sin caracteres que se confunden al dictarlos (0/O, 1/l/I)
const passwordAlphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"

func userCommand(ctx context.Context, db *pgxpool.Pool, args []string) {
	if len(args) == 0 {
		log.Fatal("uso: user add|passwd|list")
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("user add", flag.ExitOnError)
		role := fs.String("role", "student", "admin | teacher | student")
		limit := fs.Float64("limit", 2, "tope diario de consumo de IA (USD)")
		robot := fs.String("robot", "", "nombre del robot (vacío = NAO)")
		if len(args) < 3 {
			log.Fatal(`uso: user add <usuario> "<nombre>" [-role …] [-limit 2] [-robot NOMBRE]`)
		}
		_ = fs.Parse(args[3:])
		username := strings.ToLower(strings.TrimSpace(args[1]))
		// NAO_PASSWORD: contraseña elegida (por entorno, para que no quede en el historial); si no, una al azar
		password := os.Getenv("NAO_PASSWORD")
		if password == "" {
			password = newPassword()
		}
		hash := mustHash(password)
		var robotName *string
		if *robot != "" {
			robotName = robot
		}
		if _, err := db.Exec(ctx, `
			INSERT INTO users (username, display_name, password_hash, role, daily_limit_usd, robot_name)
			VALUES ($1, $2, $3, $4, $5, $6)`, username, args[2], hash, *role, *limit, robotName); err != nil {
			log.Fatalf("no se pudo crear %s: %v", username, err)
		}
		fmt.Printf("usuario %s creado · rol %s · tope US$%.2f/día\ncontraseña: %s\n", username, *role, *limit, password)
	case "passwd":
		if len(args) < 2 {
			log.Fatal("uso: user passwd <usuario>")
		}
		// NAO_PASSWORD: contraseña elegida (por entorno, como en add); si no, una al azar
		password := os.Getenv("NAO_PASSWORD")
		if password == "" {
			password = newPassword()
		}
		tag, err := db.Exec(ctx, `UPDATE users SET password_hash = $1 WHERE username = $2`, mustHash(password), strings.ToLower(args[1]))
		if err != nil || tag.RowsAffected() == 0 {
			log.Fatalf("no se pudo cambiar la contraseña de %s: %v", args[1], err)
		}
		// Cambiar la contraseña cierra las sesiones abiertas
		_, _ = db.Exec(ctx, `DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = $1)`, strings.ToLower(args[1]))
		fmt.Printf("contraseña nueva de %s: %s\n", args[1], password)
	case "list":
		rows, err := db.Query(ctx, `SELECT username, display_name, role, daily_limit_usd::float8, disabled, last_login_at FROM users ORDER BY id`)
		if err != nil {
			log.Fatal(err)
		}
		defer rows.Close()
		for rows.Next() {
			var username, name, role string
			var limit float64
			var disabled bool
			var last any
			if err := rows.Scan(&username, &name, &role, &limit, &disabled, &last); err != nil {
				log.Fatal(err)
			}
			fmt.Fprintf(os.Stdout, "%-12s %-20s %-8s US$%.2f/día  deshabilitado=%v  último ingreso=%v\n", username, name, role, limit, disabled, last)
		}
	default:
		log.Fatalf("subcomando desconocido: user %s", args[0])
	}
}

func newPassword() string {
	b := make([]byte, 14)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(passwordAlphabet))))
		if err != nil {
			log.Fatal(err)
		}
		b[i] = passwordAlphabet[n.Int64()]
	}
	return string(b)
}

func mustHash(password string) string {
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		log.Fatal(err)
	}
	return string(h)
}
