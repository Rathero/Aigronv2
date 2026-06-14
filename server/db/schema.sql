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
  base_atk_p INT, base_atk_s INT, base_def_p INT, base_def_s INT,  -- ATK/DEF físico y especial
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
-- Migración para BD existentes: añade las columnas de stats físico/especial.
ALTER TABLE creature_templates ADD COLUMN IF NOT EXISTS base_atk_p INT;
ALTER TABLE creature_templates ADD COLUMN IF NOT EXISTS base_atk_s INT;
ALTER TABLE creature_templates ADD COLUMN IF NOT EXISTS base_def_p INT;
ALTER TABLE creature_templates ADD COLUMN IF NOT EXISTS base_def_s INT;
ALTER TABLE creature_templates ADD COLUMN IF NOT EXISTS type2 TEXT;  -- segundo tipo (opcional)
-- Naturaleza de la plantilla: 'season' (álbum mensual, batch_date=día 1 del mes),
-- 'unique' (criatura exclusiva del día, batch_date=ese día) o 'daily' (lotes
-- diarios legacy). El álbum coleccionable filtra por kind='season'. El DEFAULT es
-- 'daily' a propósito: las filas PREEXISTENTES son lotes diarios antiguos, NUNCA
-- temporadas; así un lote viejo fechado el día 1 no se confunde con el álbum.
-- generateSeason/generateDailyUnique insertan kind explícito ('season'/'unique').
ALTER TABLE creature_templates ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'daily';

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
-- Sendero de evolución elegido por el jugador (OFENSIVO/DEFENSIVO/VELOZ) o NULL.
ALTER TABLE creature_instances ADD COLUMN IF NOT EXISTS evo_path TEXT;
CREATE INDEX IF NOT EXISTS idx_instances_user ON creature_instances(user_id);

CREATE TABLE IF NOT EXISTS teams (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  slot1      UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  slot2      UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  slot3      UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  snapshot   JSONB,
  avg_level  NUMERIC,   -- nivel medio del snapshot, materializado para el matchmaking
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Migración para BD existentes: materializa avg_level (lo mantiene PUT /team).
ALTER TABLE teams ADD COLUMN IF NOT EXISTS avg_level NUMERIC;
UPDATE teams SET avg_level = (SELECT avg((e->>'level')::numeric) FROM jsonb_array_elements(snapshot) e)
 WHERE avg_level IS NULL AND snapshot IS NOT NULL AND jsonb_array_length(snapshot) > 0;
CREATE INDEX IF NOT EXISTS idx_teams_avg_level ON teams(avg_level);

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
CREATE INDEX IF NOT EXISTS idx_battles_attacker ON battles(attacker_id, daily_date);

CREATE TABLE IF NOT EXISTS daily_scores (
  daily_date DATE NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wins       INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (daily_date, user_id)
);
-- Ranking diario: top por victorias sin ordenar toda la tabla.
CREATE INDEX IF NOT EXISTS idx_daily_scores_top ON daily_scores(daily_date, wins DESC);
-- Ranking de liga: top por puntos sin escanear users completa.
CREATE INDEX IF NOT EXISTS idx_users_league_points ON users(league_points DESC);

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
-- Dificultad de la run ACTIVA (Fácil/Normal/Difícil/Experto/Pesadilla).
ALTER TABLE dungeon_runs ADD COLUMN IF NOT EXISTS difficulty TEXT NOT NULL DEFAULT 'NORMAL';

-- Mejor profundidad del día por (usuario, dificultad): soporta runs ILIMITADAS y
-- ranking por dificultad. Se actualiza al terminar cada run.
CREATE TABLE IF NOT EXISTS dungeon_scores (
  daily_date DATE NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  difficulty TEXT NOT NULL,
  best_depth INT  NOT NULL DEFAULT 0,
  cleared    BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (daily_date, user_id, difficulty)
);
CREATE INDEX IF NOT EXISTS idx_dscores ON dungeon_scores(daily_date, difficulty, best_depth DESC);

-- Metadatos de la app (marcas de jobs idempotentes: cierre semanal de ligas...).
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Histórico del cierre semanal de ligas (perfil / salón de la fama).
CREATE TABLE IF NOT EXISTS league_weeks (
  week_start   DATE NOT NULL,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  league       TEXT NOT NULL,
  points       INT  NOT NULL,
  reward_coins INT  NOT NULL DEFAULT 0,
  reward_gems  INT  NOT NULL DEFAULT 0,
  PRIMARY KEY (week_start, user_id)
);

-- Replay de un combate: equipos + log de eventos + estado final (el combate es
-- determinista, así que esto basta para reproducirlo 1:1 en el cliente).
ALTER TABLE battles ADD COLUMN IF NOT EXISTS replay JSONB;

-- Contadores de PERFIL (se actualizan en el momento del evento; sobreviven a la
-- poda de `battles`, que solo retiene ~30 días).
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_wins       INT  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_losses     INT  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS best_streak      INT  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS best_league      TEXT NOT NULL DEFAULT 'BRONCE';
ALTER TABLE users ADD COLUMN IF NOT EXISTS dungeons_cleared INT  NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS fusions_done     INT  NOT NULL DEFAULT 0;
-- Contador de "pity" (suavizado anti-repetidos): sube con cada duplicado del
-- huevo/tienda y, al llegar al umbral, garantiza una criatura aún no poseída.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pity_count       INT  NOT NULL DEFAULT 0;

-- Misiones SEMANALES (las diarias retienen el día; estas retienen la semana).
CREATE TABLE IF NOT EXISTS weekly_missions (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start      DATE NOT NULL,
  wins            INT  NOT NULL DEFAULT 0,
  dungeon_depth   INT  NOT NULL DEFAULT 0,   -- mejor profundidad de la semana
  fusions         INT  NOT NULL DEFAULT 0,
  claimed_wins    BOOLEAN NOT NULL DEFAULT false,
  claimed_dungeon BOOLEAN NOT NULL DEFAULT false,
  claimed_fusions BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, week_start)
);

-- Logros reclamados (el progreso se deriva de los contadores; aquí solo lo cobrado).
CREATE TABLE IF NOT EXISTS achievements (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

-- ===================== MECÁNICAS INNOVADORAS (estado) =======================
-- Puzzle Diario: una entrada por (usuario, día). Guarda el mejor resultado
-- (menos turnos = mejor; desempata HP restante). Ranking diario por turnos.
CREATE TABLE IF NOT EXISTS puzzle_results (
  daily_date DATE NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  turns      INT  NOT NULL,
  hp_left    INT  NOT NULL DEFAULT 0,
  solved     BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (daily_date, user_id)
);
CREATE INDEX IF NOT EXISTS idx_puzzle_rank ON puzzle_results(daily_date, solved, turns ASC, hp_left DESC);

-- Ecos de la Mazmorra: equipos caídos (snapshot) que aparecen como encuentros
-- en las runs de OTROS jugadores ese día. avenged = veces que lo han derrotado.
CREATE TABLE IF NOT EXISTS dungeon_echoes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  daily_date  DATE NOT NULL,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_name  TEXT NOT NULL,
  depth       INT  NOT NULL,
  difficulty  TEXT NOT NULL,
  team        JSONB NOT NULL,   -- snapshot del equipo caído (stats escalados)
  coins_bounty INT NOT NULL DEFAULT 0,
  avenged     INT  NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_echoes_day ON dungeon_echoes(daily_date, depth);

-- Jefe Mundial: un evento por ventana (week_start). HP global compartido; el
-- daño se acumula de toda la comunidad. contributions = daño por usuario.
CREATE TABLE IF NOT EXISTS world_boss (
  id          TEXT PRIMARY KEY,            -- 'boss:<week_start>'
  week_start  DATE NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  hp_max      BIGINT NOT NULL,
  hp_left     BIGINT NOT NULL,
  defeated_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Arte IA del jefe (generado por el job semanal si hay proveedor; emoji si no).
ALTER TABLE world_boss ADD COLUMN IF NOT EXISTS image_url TEXT;
CREATE TABLE IF NOT EXISTS world_boss_contrib (
  boss_id    TEXT NOT NULL REFERENCES world_boss(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  damage     BIGINT NOT NULL DEFAULT 0,
  hits       INT    NOT NULL DEFAULT 0,
  rewarded   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (boss_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_wbcontrib ON world_boss_contrib(boss_id, damage DESC);

-- Némesis: rival IA recurrente por usuario. Persiste el marcador y "tier" que
-- sube cuando le ganas (vuelve más fuerte).
CREATE TABLE IF NOT EXISTS nemesis (
  user_id    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  tier       INT  NOT NULL DEFAULT 1,
  wins_vs_me INT  NOT NULL DEFAULT 0,   -- veces que la némesis me ha ganado
  my_wins    INT  NOT NULL DEFAULT 0,   -- veces que la he derrotado
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Suscripciones Web Push (recordatorio diario del lote, cierres de liga...).
CREATE TABLE IF NOT EXISTS push_subs (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL,
  sub        JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, endpoint)
);

-- CONSTELACIONES (gremios, #1): grupos de jugadores. El "poder" de una
-- constelación se agrega de los stats existentes de sus miembros (SUM de
-- league_points), sin nuevos hooks de escritura. La pertenencia vive en
-- users.guild_id (un jugador, una constelación).
CREATE TABLE IF NOT EXISTS guilds (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  tag        TEXT NOT NULL,                         -- 2-4 chars, mostrado junto al nombre
  owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guilds_name ON guilds (lower(name));
ALTER TABLE users ADD COLUMN IF NOT EXISTS guild_id UUID REFERENCES guilds(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS guild_joined_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_users_guild ON users(guild_id);

-- Recompensa por DEFENSA async (#PvP): cuando tu snapshot gana mientras estás
-- offline (el atacante pierde), ganas un stat + monedas con tope diario.
ALTER TABLE users ADD COLUMN IF NOT EXISTS defense_wins      INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS def_rewards_today INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS def_rewards_date  DATE;

-- Muro / chat de la constelación (texto plano; se ESCAPA al renderizar).
CREATE TABLE IF NOT EXISTS guild_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id   UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gmsg ON guild_messages(guild_id, created_at DESC);

-- Reclamo de la MISIÓN SEMANAL de constelación (uno por miembro y semana). El
-- progreso se agrega de las victorias PvP semanales de los miembros (sin hooks
-- nuevos: reusa weekly_missions.wins).
CREATE TABLE IF NOT EXISTS guild_week_claims (
  guild_id   UUID NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, week_start, user_id)
);

-- TRUEQUE (#2): ofertas de intercambio de DUPLICADOS entre jugadores. El que
-- ofrece "reserva" una instancia suya; cualquiera con una instancia de la
-- plantilla deseada puede aceptar. El swap es transaccional (cambia el owner de
-- las dos instancias a la vez). Solo cosmético/colección: no se comercia poder
-- pagable (respeta la monetización no tóxica del README §4).
CREATE TABLE IF NOT EXISTS trade_offers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status        TEXT NOT NULL DEFAULT 'open',       -- open | done | cancelled
  from_user     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  offer_inst    UUID NOT NULL REFERENCES creature_instances(instance_id) ON DELETE CASCADE,
  offer_tpl     TEXT NOT NULL,                      -- plantilla ofrecida (para listar)
  want_tpl      TEXT NOT NULL,                      -- plantilla deseada a cambio
  to_user       UUID REFERENCES users(id) ON DELETE SET NULL,  -- quién la aceptó
  taken_inst    UUID REFERENCES creature_instances(instance_id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trades_open ON trade_offers(status, want_tpl);
CREATE INDEX IF NOT EXISTS idx_trades_from ON trade_offers(from_user, status);
-- Una instancia no puede estar reservada en dos ofertas abiertas a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_offer_inst ON trade_offers(offer_inst) WHERE status='open';
