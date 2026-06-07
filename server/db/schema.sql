-- =============================================================================
-- schema.sql — Esquema PostgreSQL de AIGRONS (ver docs/criaturas-imposibles.md §6.3)
-- Nota: image_url es NULLable porque, de momento, el cliente dibuja el sprite
-- proceduralmente desde art_seed. Cuando conectes el pipeline de imagen IA,
-- rellena image_url / image_thumb_url en el job de generación.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS users (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name      TEXT NOT NULL,
  auth_provider     TEXT NOT NULL,
  auth_subject      TEXT NOT NULL UNIQUE,
  coins             INT  NOT NULL DEFAULT 250,
  gems              INT  NOT NULL DEFAULT 5,
  dust              INT  NOT NULL DEFAULT 40,
  energy            INT  NOT NULL DEFAULT 5,
  energy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  league            TEXT NOT NULL DEFAULT 'BRONCE',
  league_points     INT  NOT NULL DEFAULT 0,
  daily_streak      INT  NOT NULL DEFAULT 0,
  last_claim_date   DATE,
  rolls_today       INT  NOT NULL DEFAULT 0,
  rolls_date        DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS creature_templates (
  template_id     TEXT PRIMARY KEY,
  batch_date      DATE NOT NULL,
  name            TEXT NOT NULL,
  species_tags    TEXT[] NOT NULL DEFAULT '{}',
  type            TEXT NOT NULL,
  rarity          TEXT NOT NULL,
  base_hp  INT NOT NULL, base_atk INT NOT NULL, base_def INT NOT NULL, base_spd INT NOT NULL,
  ability_id      TEXT NOT NULL,
  lore            TEXT,
  image_url       TEXT,
  image_thumb_url TEXT,
  art_seed        BIGINT,
  quality_score   REAL,
  is_fusion       BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_templates_batch ON creature_templates(batch_date);

CREATE TABLE IF NOT EXISTS creature_instances (
  instance_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  template_id    TEXT NOT NULL REFERENCES creature_templates(template_id),
  level          INT  NOT NULL DEFAULT 1,
  xp             INT  NOT NULL DEFAULT 0,
  favorite       BOOLEAN NOT NULL DEFAULT false,
  locked         BOOLEAN NOT NULL DEFAULT false,
  cosmetic_frame TEXT,
  obtained_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instances_user ON creature_instances(user_id);

CREATE TABLE IF NOT EXISTS teams (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slot1      UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  slot2      UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  slot3      UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  snapshot   JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS battles (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  defender_id UUID REFERENCES users(id),
  seed        BIGINT NOT NULL,
  result      TEXT NOT NULL,
  daily_date  DATE NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_battles_daily ON battles(daily_date, attacker_id);

CREATE TABLE IF NOT EXISTS daily_scores (
  daily_date DATE NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wins       INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (daily_date, user_id)
);

-- Oferta de combate pendiente: el servidor decide el rival en /battle/find y lo
-- "congela" aquí (snapshot + seed) para recalcular de forma segura en /resolve.
-- Así el cliente no puede falsear al rival (anti-trampa, doc §6.4).
CREATE TABLE IF NOT EXISTS battle_offers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attacker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  defender_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- null si el rival es un bot
  seed        BIGINT NOT NULL,
  opponent    JSONB NOT NULL,        -- unidades del rival ya escaladas (snapshot)
  consumed    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_offers_attacker ON battle_offers(attacker_id);

-- Progreso de misiones diarias (server-side, doc §3.11).
CREATE TABLE IF NOT EXISTS daily_missions (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  daily_date      DATE NOT NULL,
  wins            INT  NOT NULL DEFAULT 0,
  claims          INT  NOT NULL DEFAULT 0,
  abilities       INT  NOT NULL DEFAULT 0,
  claimed_win     BOOLEAN NOT NULL DEFAULT false,
  claimed_claim   BOOLEAN NOT NULL DEFAULT false,
  claimed_ability BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, daily_date)
);

-- Caché de fusiones por par ordenado de plantillas (doc §3.7 / §5.6): el arte de
-- una combinación no se regenera dos veces.
CREATE TABLE IF NOT EXISTS fusion_cache (
  pair_key    TEXT PRIMARY KEY,                 -- 'fusion:<minId>:<maxId>'
  template_id TEXT NOT NULL REFERENCES creature_templates(template_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mazmorra del día (roguelike): una run por usuario. El servidor es autoritativo:
-- guarda el estado (equipo con HP arrastrado, reliquias, monedas, etapa) y lo
-- avanza paso a paso. La semilla es diaria y compartida -> ranking justo.
CREATE TABLE IF NOT EXISTS dungeon_runs (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_date  DATE NOT NULL,
  seed        BIGINT NOT NULL,
  depth       INT  NOT NULL DEFAULT 0,          -- nodos superados
  status      TEXT NOT NULL DEFAULT 'active',   -- active | cleared | dead
  state       JSONB NOT NULL,                   -- { team, relics, coins, stage, ... }
  best_depth  INT  NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_dungeon_daily ON dungeon_runs(daily_date, depth DESC);
