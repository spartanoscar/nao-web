-- Base de datos de NAO Web (PostgreSQL 12 + pgvector 0.5.1 del servidor de Bukivo).
-- Idempotente y solo aditiva (como bukivo/db): nao-api la aplica al arrancar y con `nao-api migrate`.
-- Las extensiones las crea el superusuario una sola vez (scripts/deploy.sh db-setup); aquí no fallan si ya existen.
-- Fechas en timestamptz; el "día" del control de costos es el de America/Bogota.

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;

-- ─── Usuarios y sesiones ─────────────────────────────────────────────────────
-- Solo entran los usuarios registrados (no hay registro abierto): se crean con `nao-api user add`.
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  username        CITEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  password_hash   TEXT NOT NULL,                -- bcrypt
  role            TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin', 'teacher', 'student')),
  robot_name      TEXT,                         -- el nombre que le puso a su NAO (null = "NAO")
  daily_limit_usd NUMERIC(10, 4) NOT NULL DEFAULT 2, -- tope diario de consumo de IA
  disabled        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);

-- Ajustes del jugador (modal de ajustes): instrucciones propias para su NAO (se suman al prompt base cuando llegue
-- la IA) y foto de perfil (JPEG cuadrado que el navegador ya recorta y reduce)
ALTER TABLE users ADD COLUMN IF NOT EXISTS prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_updated_at TIMESTAMPTZ;
-- Apariencia de su NAO (paleta libre, '#rrggbb'; null = la original): carcasa y ojos. Así cada uno se distingue en el
-- mundo compartido y su NAO se ve igual en cualquier equipo
ALTER TABLE users ADD COLUMN IF NOT EXISTS shell_color TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS eye_color TEXT;

-- La cookie lleva un token aleatorio; aquí solo se guarda su SHA-256 (si se filtra la tabla, no sirve)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   BYTEA PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

-- ─── Control de costos (F9) ──────────────────────────────────────────────────
-- Patrón de Rondax: cada llamada a la IA queda registrada con su costo real, y el gasto del día se acumula
-- aparte para validar el tope en cada llamada sin sumar todo el registro.
CREATE TABLE IF NOT EXISTS ai_usage_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  feature       TEXT NOT NULL,                  -- 'live' (conversación), 'vision', 'embedding'…
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  audio_seconds REAL NOT NULL DEFAULT 0,
  images        INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ai_usage_user_time ON ai_usage_log (user_id, created_at);

CREATE TABLE IF NOT EXISTS ai_daily_spending (
  user_id   BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  total_usd NUMERIC(12, 6) NOT NULL DEFAULT 0,
  calls     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);

-- ─── Conversaciones (F8/F10) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at   TIMESTAMPTZ,
  title      TEXT
);
CREATE INDEX IF NOT EXISTS conversations_user ON conversations (user_id, started_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  speaker         TEXT NOT NULL CHECK (speaker IN ('user', 'nao', 'system')),
  text            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, id);

-- ─── Rostros (F11) ───────────────────────────────────────────────────────────
-- Solo el embedding de face-api (128 floats, como Rondax), nunca la foto. La biometría es dato sensible
-- (Ley 1581 de 2012): sin consentimiento no se guarda.
CREATE TABLE IF NOT EXISTS faces (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  person_name TEXT NOT NULL,
  embedding   vector(128) NOT NULL,
  consent_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS faces_user ON faces (user_id);
-- Constancia de la autorización (Ley 1581): las palabras con que la persona aceptó que el NAO la recordara
ALTER TABLE faces ADD COLUMN IF NOT EXISTS consent_note TEXT;

-- ─── Memoria del mundo (F10) ─────────────────────────────────────────────────
-- Dónde quedó el robot y qué se movió, para volver a entrar desde otro equipo y encontrarlo igual
CREATE TABLE IF NOT EXISTS world_state (
  user_id    BIGINT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  robot      JSONB,
  objects    JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Lugares que aprendió con cada usuario ("baño" → x, y en metros)
CREATE TABLE IF NOT EXISTS places (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  x          DOUBLE PRECISION NOT NULL,
  y          DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- ─── Conocimiento propio (F12, RAG) ──────────────────────────────────────────
-- Fragmentos de documentos con embedding de gemini-embedding-2 (1536 dims, como Rondax/Noha)
CREATE TABLE IF NOT EXISTS documents (
  id         BIGSERIAL PRIMARY KEY,
  owner_id   BIGINT REFERENCES users (id) ON DELETE SET NULL, -- null = de todos
  title      TEXT NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Biblioteca del jugador (modal de ajustes → Biblioteca): el archivo original (≤ 4 MB, las imágenes ya reducidas en el
-- navegador) vive aquí mismo para que lo cubra el respaldo de la BD. Estados: pending → processing → ready | error.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'text';  -- image | pdf | excel | word | text
ALTER TABLE documents ADD COLUMN IF NOT EXISTS mime TEXT NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS size_bytes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS content BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS thumb BYTEA;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extracted_text TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS error TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(12, 6) NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX IF NOT EXISTS documents_owner ON documents (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS documents_queue ON documents (updated_at) WHERE status IN ('pending', 'processing');

CREATE TABLE IF NOT EXISTS document_chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536) NOT NULL
);
CREATE INDEX IF NOT EXISTS document_chunks_embedding ON document_chunks USING hnsw (embedding vector_cosine_ops);
