// =============================================================================
// app.js — Servidor Express con todos los endpoints (ver docs §6.4).
// Endurecido para producción: helmet, rate limiting, validación, manejo de
// errores, apagado ordenado y cron de generación nocturna en proceso.
// =============================================================================
// Carga server/.env independientemente del directorio de trabajo (cwd) desde el
// que se lance el proceso (p. ej. preview lo arranca desde la raíz del repo).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");

const db = require("./db");
const C = require("./config");
const combat = require("./combat");
const auth = require("./auth");
const { sign, authMiddleware, verifyIdentity } = auth;
const { generateSeason, generateDailyUnique, rebalanceTemplates } = require("./jobs/generateDailyBatch");
const variantArt = require("./variantArt");
const { startCron } = require("./cron");
const { fuse } = require("./fusion");
const dungeon = require("./dungeon");
const leagues = require("./leagues");
const { startMaintenance } = require("./maintenance");
const weekly = require("./missions");
const achievements = require("./achievements");
const push = require("./push");
const features = require("./features");
const innov = require("./innovations");
const guilds = require("./guilds");
const trades = require("./trades");
const { eventFor } = require("./jobs/generateDailyBatch");
const { tplBaseStats, tplTypes } = require("./util");

const app = express();
app.set("trust proxy", 1); // detrás de proxy/CDN: IP real para rate limiting

// --- Seguridad de cabeceras. CSP permite el frontend inline + Google Fonts. ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Google Sign-In (GIS): script + iframe + estilos + conexión a accounts.google.com.
        // Sin 'unsafe-inline': todo el JS del frontend vive en ficheros propios
        // (web/app.js, web/engine.js), lo que bloquea XSS por script inyectado.
        scriptSrc: ["'self'", "https://accounts.google.com/gsi/client"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://accounts.google.com/gsi/style"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://accounts.google.com"],
        frameSrc: ["'self'", "https://accounts.google.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
    // Permite la ventana emergente de Google Sign-In (comunicación con el opener).
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  })
);

const CORS_ORIGIN = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*";
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "256kb" }));

// Rate limiting: general + login estricto (anti fuerza bruta).
// Con REDIS_URL definido usa un store compartido (necesario con >1 instancia
// detrás del proxy: el contador en memoria por proceso deja de proteger).
// Sin REDIS_URL (o sin las dependencias opcionales) cae al store en memoria.
function buildRedisStore(prefix) {
  if (!process.env.REDIS_URL) return undefined;
  try {
    const { RedisStore } = require("rate-limit-redis");
    const { createClient } = require("redis");
    const client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (e) => console.error("[redis] error:", e.message));
    client.connect().catch((e) => console.error("[redis] no se pudo conectar:", e.message));
    return new RedisStore({ prefix, sendCommand: (...args) => client.sendCommand(args) });
  } catch (e) {
    console.warn("[rate-limit] REDIS_URL definido pero faltan dependencias (redis/rate-limit-redis); usando memoria:", e.message);
    return undefined;
  }
}
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false, store: buildRedisStore("rl:gen:") });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, store: buildRedisStore("rl:login:") });
app.use("/auth/", loginLimiter);
app.use(generalLimiter);

// Sirve el frontend en / para probar en local (http://localhost:3000)
app.use(express.static(path.join(__dirname, "../../web")));
// Landing pública de marketing (aigrons.com): mismo origen => sin CORS.
app.use("/landing", express.static(path.join(__dirname, "../../landing")));

// El catálogo coleccionable es MENSUAL: un álbum grande (~180) que cambia cada
// mes. Sobre él rota un destacado diario (~18) que alimenta puzzle/mazmorra/
// arena/oráculo y pondera el huevo/tienda.
const SEASON_N = parseInt(process.env.SEASON_SIZE || "180", 10);
const HIGHLIGHT_N = parseInt(process.env.HIGHLIGHT_SIZE || "18", 10);
const PITY_THRESHOLD = parseInt(process.env.PITY_THRESHOLD || "8", 10);

// --------------------------------- helpers ----------------------------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Orden de ligas como expresión SQL (para comparar best_league).
const leagueOrdSql = (col) =>
  `CASE ${col} WHEN 'DIAMANTE' THEN 4 WHEN 'PLATINO' THEN 3 WHEN 'ORO' THEN 2 WHEN 'PLATA' THEN 1 ELSE 0 END`;

function yesterdayStr() {
  return C.todayStr(new Date(Date.now() - 86400000));
}
const TPL_COLS = "template_id,name,type,type2,rarity,ability_id,base_hp,base_atk,base_def,base_spd,base_atk_p,base_atk_s,base_def_p,base_def_s,art_seed,lore,image_url,image_thumb_url";
function rowToTpl(x) {
  return {
    id: x.template_id, name: x.name, type: x.type, types: tplTypes(x), rarity: x.rarity, ability: x.ability_id,
    art_seed: x.art_seed, lore: x.lore, image_url: x.image_url, image_thumb_url: x.image_thumb_url,
    base_stats: tplBaseStats(x),
  };
}
// Una plantilla por id (con tags: el prompt de arte de variantes las usa).
async function tplById(id) {
  const r = await db.query(`SELECT ${TPL_COLS}, species_tags FROM creature_templates WHERE template_id=$1`, [id]);
  if (!r.rows[0]) return null;
  const t = rowToTpl(r.rows[0]);
  t.tags = r.rows[0].species_tags || [];
  return t;
}
// Si una instancia recién creada salió ÁUREA, dispara (sin bloquear) la
// generación perezosa de su arte dorado. Se llama desde huevo/tienda/única.
function maybeAureaArt(instanceId, tplId) {
  if (C.variantOf(instanceId) !== "aurea") return;
  tplById(tplId)
    .then((base) => { if (base) variantArt.ensureVariantArtAsync(base, "aurea"); })
    .catch(() => {});
}
// Garantiza que el ÁLBUM mensual existe (lo inserta al instante SIN arte: las
// plantillas son deterministas; el arte IA se rellena luego vía cron/admin). El
// advisory lock evita que varios clientes lo generen a la vez tras el cambio de mes.
async function ensureSeason(sKey) {
  const r = await db.query("SELECT 1 FROM creature_templates WHERE batch_date=$1 AND kind='season' AND is_fusion=false LIMIT 1", [sKey]);
  if (r.rowCount > 0) return;
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["season:" + sKey]);
    const again = await db.query("SELECT 1 FROM creature_templates WHERE batch_date=$1 AND kind='season' AND is_fusion=false LIMIT 1", [sKey]);
    if (again.rowCount === 0) await generateSeason(sKey, SEASON_N, { withArt: false });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["season:" + sKey]).catch(() => {});
    client.release();
  }
}
// El ÁLBUM de la temporada actual (pool completo ~180). Sustituye al antiguo
// "lote de hoy": es la base coleccionable estable del mes.
async function seasonTemplates(date) {
  const sKey = C.seasonKey(date || C.todayStr());
  await ensureSeason(sKey);
  const r = await db.query(
    `SELECT ${TPL_COLS} FROM creature_templates WHERE batch_date=$1 AND kind='season' AND is_fusion=false ORDER BY template_id`,
    [sKey]
  );
  return r.rows.map(rowToTpl);
}
// El DESTACADO del día: subconjunto rotatorio (~18) del álbum, determinista por
// fecha. Es lo que alimenta puzzle/mazmorra/arena/oráculo/bots (variedad diaria
// sobre un álbum estable). Antes esto era el "lote de hoy" entero.
async function dailyTemplates(date) {
  const day = date || C.todayStr();
  const pool = await seasonTemplates(day);
  return C.dailyHighlights(day, pool, HIGHLIGHT_N);
}
// Compat: algunos módulos esperan `todayTemplates`. Apunta al destacado del día.
const todayTemplates = dailyTemplates;

// Ids del álbum de la temporada que el usuario YA posee (para el pity y el álbum).
async function ownedSeasonIds(userId, sKey) {
  const r = await db.query(
    `SELECT DISTINCT t.template_id FROM creature_instances ci
       JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.user_id=$1 AND t.batch_date=$2 AND t.kind='season'`,
    [userId, sKey]
  );
  return new Set(r.rows.map((x) => x.template_id));
}
// Tira una criatura del álbum con: (1) sesgo hacia el destacado del día (x3),
// (2) duplicado -> polvo extra, (3) pity suave: al acumular PITY_THRESHOLD
// duplicados, garantiza una NO poseída (preferiblemente del destacado). Devuelve
// { template, duplicate, dust }. Persiste pity_count y, si toca, el polvo.
async function drawFromSeason(u) {
  const sKey = C.seasonKey();
  const pool = await seasonTemplates();
  const highlights = C.dailyHighlights(C.todayStr(), pool, HIGHLIGHT_N);
  const hiIds = new Set(highlights.map((t) => t.id));
  const owned = await ownedSeasonIds(u.id, sKey);

  let template = null, forced = false;
  if ((u.pity_count || 0) >= PITY_THRESHOLD) {
    const unowned = pool.filter((t) => !owned.has(t.id));
    if (unowned.length) {
      const hu = unowned.filter((t) => hiIds.has(t.id));
      const cand = hu.length ? hu : unowned;
      template = cand[Math.floor(Math.random() * cand.length)];
      forced = true;
    }
  }
  if (!template) {
    // Lista ponderada: destacados x3, resto x1 (determinismo no aplica: la tirada
    // es aleatoria por diseño; lo determinista es QUÉ hay disponible).
    const weighted = [];
    for (const t of pool) { weighted.push(t); if (hiIds.has(t.id)) { weighted.push(t); weighted.push(t); } }
    template = weighted[Math.floor(Math.random() * weighted.length)];
  }
  const duplicate = owned.has(template.id);
  const newPity = (forced || !duplicate) ? 0 : (u.pity_count || 0) + 1;
  await db.query("UPDATE users SET pity_count=$1 WHERE id=$2", [newPity, u.id]);
  let dust = 0;
  if (duplicate) {
    dust = C.RELEASE_DUST[template.rarity] || 5;
    await db.query("UPDATE users SET dust=dust+$1 WHERE id=$2", [dust, u.id]);
  }
  return { template, duplicate, dust };
}

// Garantiza la criatura ÚNICA del día (kind='unique', batch_date=fecha). Se
// inserta al instante sin arte (procedural); el arte IA lo rellena cron/admin.
async function ensureDailyUnique(date) {
  const id = C.dailyUniqueId(date);
  const r = await db.query("SELECT 1 FROM creature_templates WHERE template_id=$1", [id]);
  if (r.rowCount > 0) return;
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["uniq:" + date]);
    const again = await db.query("SELECT 1 FROM creature_templates WHERE template_id=$1", [id]);
    if (again.rowCount === 0) await generateDailyUnique(date, { withArt: false });
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["uniq:" + date]).catch(() => {});
    client.release();
  }
}
async function dailyUniqueTemplate(date) {
  const day = date || C.todayStr();
  await ensureDailyUnique(day);
  const r = await db.query(`SELECT ${TPL_COLS} FROM creature_templates WHERE template_id=$1`, [C.dailyUniqueId(day)]);
  return r.rows[0] ? rowToTpl(r.rows[0]) : null;
}
const UNIQUE_COST = parseInt(process.env.DAILY_UNIQUE_COST || "200", 10);
async function getUser(id) {
  const r = await db.query("SELECT * FROM users WHERE id=$1", [id]);
  return r.rows[0];
}
async function syncEnergy(u) {
  if (u.energy >= C.ENERGY_MAX) return u;
  const last = new Date(u.energy_updated_at).getTime();
  const gained = Math.floor((Date.now() - last) / C.ENERGY_REGEN_MS);
  if (gained > 0) {
    const energy = Math.min(C.ENERGY_MAX, u.energy + gained);
    const newAt = energy >= C.ENERGY_MAX ? new Date() : new Date(last + gained * C.ENERGY_REGEN_MS);
    await db.query("UPDATE users SET energy=$1, energy_updated_at=$2 WHERE id=$3", [energy, newAt, u.id]);
    u.energy = energy; u.energy_updated_at = newAt;
  }
  return u;
}
function userPublic(u) {
  return {
    id: u.id, displayName: u.display_name,
    coins: u.coins, gems: u.gems, dust: u.dust,
    energy: u.energy, energyMax: C.ENERGY_MAX,
    // Cuándo regenera la próxima ⚡ (null si está llena): el cliente muestra la
    // cuenta atrás sin tener que conocer ENERGY_REGEN_MS ni energy_updated_at.
    energyNextAt: u.energy < C.ENERGY_MAX
      ? new Date(new Date(u.energy_updated_at).getTime() + C.ENERGY_REGEN_MS).toISOString()
      : null,
    league: u.league, leaguePoints: u.league_points,
    streak: u.daily_streak,
    totalWins: u.total_wins || 0, // revelado progresivo de módulos en el cliente
    // Tiradas de tienda de HOY (techo diario): el cliente muestra cuántas quedan.
    rollsToday: u.rolls_date && C.todayStr(new Date(u.rolls_date)) === C.todayStr() ? u.rolls_today : 0,
    rollsMax: 10,
    claimedToday: !!(u.last_claim_date && C.todayStr(new Date(u.last_claim_date)) === C.todayStr()),
    // Pity (suavizado anti-repetidos): cuántos duplicados llevas y el umbral que
    // garantiza una criatura nueva. El cliente lo muestra como barra de progreso.
    pity: u.pity_count || 0, pityMax: PITY_THRESHOLD,
  };
}

// Próximo cambio de lote = medianoche LOCAL del servidor (todayStr usa fecha
// local). El cliente lo usa para la cuenta atrás "nuevo lote en…".
function nextBatchAt() {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1).toISOString();
}

// ---------------------------- misiones diarias ------------------------------
const MISSIONS = {
  claim: { goal: 1, reward: 30, col: "claims", flag: "claimed_claim" },
  win: { goal: 3, reward: 60, col: "wins", flag: "claimed_win" },
  ability: { goal: 5, reward: 40, col: "abilities", flag: "claimed_ability" },
};
async function ensureMissionRow(userId) {
  await db.query(
    `INSERT INTO daily_missions (user_id, daily_date) VALUES ($1,$2)
     ON CONFLICT (user_id, daily_date) DO NOTHING`,
    [userId, C.todayStr()]
  );
}
async function bumpMission(userId, col, n) {
  await ensureMissionRow(userId);
  await db.query(
    `UPDATE daily_missions SET ${col} = ${col} + $1 WHERE user_id=$2 AND daily_date=$3`,
    [n, userId, C.todayStr()]
  );
}
async function missionsPublic(userId) {
  await ensureMissionRow(userId);
  const r = await db.query("SELECT * FROM daily_missions WHERE user_id=$1 AND daily_date=$2", [userId, C.todayStr()]);
  const m = r.rows[0];
  return Object.entries(MISSIONS).map(([key, def]) => {
    const progress = m[def.col];
    const claimed = m[def.flag];
    return { key, progress: Math.min(progress, def.goal), goal: def.goal, reward: def.reward, done: progress >= def.goal, claimed };
  });
}

// Construye las unidades de combate del equipo del jugador (con stats escalados).
async function buildTeamUnits(userId, team = "A") {
  const t = await db.query("SELECT slot1,slot2,slot3 FROM teams WHERE user_id=$1", [userId]);
  let slots = t.rows[0] ? [t.rows[0].slot1, t.rows[0].slot2, t.rows[0].slot3].filter(Boolean) : [];
  if (!slots.length) {
    const r = await db.query("SELECT instance_id FROM creature_instances WHERE user_id=$1 ORDER BY obtained_at LIMIT 3", [userId]);
    slots = r.rows.map((x) => x.instance_id);
  }
  if (!slots.length) return [];
  const inst = await db.query(
    `SELECT ci.instance_id, ci.level, ci.evo_path, t.template_id, t.name, t.type, t.type2, t.ability_id,
            t.base_hp, t.base_atk, t.base_def, t.base_spd, t.base_atk_p, t.base_atk_s, t.base_def_p, t.base_def_s,
            t.image_url, t.image_thumb_url
       FROM creature_instances ci JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.instance_id = ANY($1::uuid[])`,
    [slots]
  );
  const byId = {}; inst.rows.forEach((r) => (byId[r.instance_id] = r));
  // Arte de VARIANTE (forma evolucionada / áurea) si ya está generado: la unidad
  // viaja con la imagen de su forma actual, no la del base.
  const artIds = new Set();
  inst.rows.forEach((r) => {
    const st = C.evoStageAt(r.template_id, r.level);
    if (st > 0) artIds.add(C.variantArtId(r.template_id, "evo" + st));
    if (C.variantOf(r.instance_id) === "aurea") artIds.add(C.variantArtId(r.template_id, "aurea"));
  });
  const artById = {};
  if (artIds.size) {
    const ar = await db.query("SELECT template_id, image_url FROM creature_templates WHERE template_id = ANY($1) AND image_url IS NOT NULL", [[...artIds]]);
    ar.rows.forEach((a) => (artById[a.template_id] = a.image_url));
  }
  return slots.map((iid, i) => {
    const r = byId[iid]; if (!r) return null;
    // IV por instancia (±6%, deterministas del instance_id): cada captura es
    // única. Se hornean en las stats de combate; el snapshot las congela igual.
    const tplLike = { id: r.template_id, name: r.name, type: r.type, types: tplTypes(r), ability: r.ability_id, base_stats: C.applyIV(tplBaseStats(r), iid) };
    const u = combat.buildUnit(tplLike, r.level, team, i);
    if (r.evo_path && u.evoStage > 0) C.applyEvoPath(u, r.evo_path); // sendero de evolución (perfil de stats)
    u.instanceId = iid; // para mapear el capitán elegido a su uid de combate
    // Arte IA: el RIVAL puede no tener esta plantilla en su caché (lote de otro
    // día, fusión); viaja con la unidad para que la vea con su imagen real.
    // Prioridad: forma evolucionada > áurea > base.
    const evoArt = u.evoStage > 0 ? artById[C.variantArtId(r.template_id, "evo" + u.evoStage)] : null;
    const aureaArt = C.variantOf(iid) === "aurea" ? artById[C.variantArtId(r.template_id, "aurea")] : null;
    u.imageUrl = evoArt || aureaArt || r.image_url;
    u.imageThumbUrl = (evoArt || aureaArt) ? (evoArt || aureaArt) : r.image_thumb_url;
    return u;
  }).filter(Boolean);
}
const teamAvgLevel = (units) => units.length ? Math.round(units.reduce((a, u) => a + (u.level || 1), 0) / units.length) : 3;

// Arena Sellada: monta un equipo de combate desde ids de plantilla del lote de
// HOY (nivel fijo 12, sin la colección del jugador). Valida que sean del lote.
const ARENA_LEVEL = 12;
async function buildArenaUnits(ids, team = "A") {
  const tpls = await todayTemplates();
  const byId = {}; tpls.forEach((t) => (byId[t.id] = t));
  return (ids || []).slice(0, 3).map((id, i) => {
    const t = byId[id]; if (!t) return null;
    return combat.buildUnit({ id: t.id, name: t.name, type: t.type, types: t.types, ability: t.ability, base_stats: t.base_stats }, ARENA_LEVEL, team, i);
  }).filter(Boolean);
}
function publicUnit(u) {
  return { uid: u.uid, tplId: u.tplId, name: u.name, type: u.type, types: u.types, ability: u.ability, level: u.level,
    hpMax: u.hpMax, atkP: u.atkP, atkS: u.atkS, defP: u.defP, defS: u.defS, spd: u.spd, startEnergy: u.startEnergy || 0,
    image_url: u.imageUrl || null, image_thumb_url: u.imageThumbUrl || null };
}

// ---------------------------------- AUTH -------------------------------------
// Config pública para el login: el cliente la pide para inicializar Google
// Sign-In y saber si el login de invitado (dev) está permitido.
app.get("/auth/config", (req, res) => {
  res.json({ googleClientId: auth.GOOGLE_CLIENT_ID, allowDev: auth.ALLOW_DEV_AUTH, features: features.flags() });
});
// Flags de funcionalidad: el cliente los pide para mostrar/ocultar cada mecánica.
app.get("/features", (req, res) => res.json(features.flags()));
// ------------------------------ LANDING PÚBLICA ------------------------------
// Datos reales para la landing de marketing (SIN auth): temporada actual, única
// del día, destacados y una muestra del álbum. Solo expone campos que el juego
// ya muestra públicamente (nombre/lore/rareza/arte). Caché en memoria 5 min:
// aguanta picos de tráfico (Product Hunt/Reddit) sin tocar la BD por visita.
let _landingCache = { key: null, at: 0, data: null };
app.get("/api/landing", wrap(async (req, res) => {
  const today = C.todayStr();
  const now = Date.now();
  if (_landingCache.key === today && now - _landingCache.at < 5 * 60 * 1000) {
    res.set("Cache-Control", "public, max-age=300");
    return res.json(_landingCache.data);
  }
  const sKey = C.seasonKey(today);
  const pool = await seasonTemplates(today);
  const highlights = C.dailyHighlights(today, pool, HIGHLIGHT_N);
  const uniq = await dailyUniqueTemplate(today);
  // Cuántas especies del álbum ha descubierto YA la comunidad (dato real y vistoso).
  const disc = await db.query(
    `SELECT COUNT(DISTINCT ci.template_id)::int AS n FROM creature_instances ci
       JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE t.batch_date=$1 AND t.kind='season'`, [sKey]);
  const pub = (t, withLore) => ({
    id: t.id, name: t.name, type: t.type, rarity: t.rarity, art_seed: t.art_seed,
    image_url: t.image_url || null, image_thumb_url: t.image_thumb_url || null,
    ...(withLore ? { lore: t.lore } : {}),
  });
  // Muestra del álbum repartida uniformemente (estable durante el día; sin nombres:
  // en la landing las no destacadas se enseñan como silueta, igual que en el juego).
  const step = Math.max(1, Math.floor(pool.length / 24));
  const albumSample = pool.filter((_, i) => i % step === 0).slice(0, 24)
    .map((t) => ({ id: t.id, type: t.type, rarity: t.rarity, art_seed: t.art_seed, image_thumb_url: t.image_thumb_url || null }));
  const data = {
    date: today,
    season: { key: sKey, label: C.seasonLabel(today), total: pool.length, discovered: disc.rows[0].n },
    unique: uniq ? pub(uniq, true) : null,
    highlights: highlights.map((t) => pub(t, true)),
    albumSample,
  };
  _landingCache = { key: today, at: now, data };
  res.set("Cache-Control", "public, max-age=300");
  res.json(data);
}));
// Middleware: 404 si la feature de la ruta está apagada.
const requireFeature = (key) => (req, res, next) => features.on(key) ? next() : res.status(404).json({ error: "feature_disabled" });
app.post("/auth/login", wrap(async (req, res) => {
  const { provider = "dev", subject, idToken, displayName } = req.body || {};
  let identity;
  try {
    identity = await verifyIdentity({ provider, subject, idToken, displayName });
  } catch (e) {
    return res.status(401).json({ error: "auth_failed", detail: e.message });
  }
  // En conflicto NO se pisa display_name: el nombre del usuario es suyo una vez
  // creado (un login posterior no debe machacar un nombre personalizado).
  const up = await db.query(
    `INSERT INTO users (display_name, auth_provider, auth_subject)
     VALUES ($1,$2,$3)
     ON CONFLICT (auth_subject) DO UPDATE SET auth_provider = EXCLUDED.auth_provider
     RETURNING *`,
    [identity.displayName, provider, identity.subject]
  );
  let user = up.rows[0];

  // SIN starters al crear cuenta: tu primer aigrón es el del PRIMER reclamo
  // (sale potenciado como "tu estrella" + 2 crías de compañía en /daily/claim).
  // Antes regalábamos 3 a nivel 3 y el huevo inicial decepcionaba (feedback).
  res.json({ token: sign(user), user: userPublic(user) });
}));

// ----------------------------------- ME -------------------------------------
app.get("/me", authMiddleware, wrap(async (req, res) => {
  let u = await getUser(req.userId);
  if (!u) return res.status(404).json({ error: "no_user" });
  u = await syncEnergy(u);
  const pub = userPublic(u);
  pub.missions = await missionsPublic(u.id);
  pub.weeklyMissions = await weekly.weeklyPublic(u.id);
  res.json(pub);
}));

// ---------------------------------- DAILY ------------------------------------
// El huevo del día. NO expone el lote disponible (el álbum es mensual y se ve en
// su propia vista): solo lo necesario para el huevo + la temporada actual + si
// queda por reclamar la criatura única del día.
app.get("/daily", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  const today = C.todayStr();
  const sKey = C.seasonKey(today);
  const ownsUnique = (await db.query(
    "SELECT 1 FROM creature_instances WHERE user_id=$1 AND template_id=$2 LIMIT 1", [u.id, C.dailyUniqueId(today)]
  )).rowCount > 0;
  // `highlights` = el DESTACADO del día (rotación curada ~18), NO el álbum
  // completo: alimenta previews deterministas del cliente (p.ej. mazmorra) y se
  // marca en el álbum. El pool mensual entero solo se ve en la vista de álbum.
  res.json({
    date: today,
    claimed: userPublic(u).claimedToday,
    nextBatchAt: nextBatchAt(),
    event: eventFor(today),
    season: { key: sKey, label: C.seasonLabel(today) },
    unique: { available: !ownsUnique, owned: ownsUnique, cost: UNIQUE_COST },
    highlights: await dailyTemplates(today),
  });
}));

app.post("/daily/claim", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  // Marca el reclamo de forma ATÓMICA (un solo UPDATE condicional): dos
  // peticiones concurrentes no pueden reclamar dos veces el mismo día.
  const streak = u.last_claim_date && C.todayStr(new Date(u.last_claim_date)) === yesterdayStr() ? u.daily_streak + 1 : 1;
  const claim = await db.query(
    `UPDATE users SET last_claim_date=$1, daily_streak=$2, coins=coins+30,
            best_streak=GREATEST(best_streak,$2)
      WHERE id=$3 AND (last_claim_date IS NULL OR last_claim_date <> $1)
      RETURNING id`,
    [C.todayStr(), streak, u.id]
  );
  if (!claim.rowCount) return res.status(400).json({ error: "already_claimed" });
  // PRIMER reclamo de la cuenta = "tu estrella" (vía Pokémon, feedback de
  // jugadores): rareza garantizada >COMÚN del álbum, nivel 5, favorita+protegida,
  // y 2 crías de nivel 1 (del destacado del día) se unen para completar el equipo.
  // Reclamos posteriores: tirada del álbum con pity (anti-repetidos) y polvo por
  // duplicado.
  const cnt = await db.query("SELECT COUNT(*)::int AS n FROM creature_instances WHERE user_id=$1", [u.id]);
  const isFirst = cnt.rows[0].n === 0;
  let t, duplicate = false, dust = 0;
  if (isFirst) {
    const seasonPool = await seasonTemplates();
    const nonCommon = seasonPool.filter((x) => x.rarity !== "COMUN");
    const starPool = nonCommon.length ? nonCommon : seasonPool;
    t = starPool[Math.floor(Math.random() * starPool.length)];
  } else {
    const drawn = await drawFromSeason(u);
    t = drawn.template; duplicate = drawn.duplicate; dust = drawn.dust;
  }
  let ins;
  const companions = [];
  try {
    ins = await db.query(
      "INSERT INTO creature_instances (user_id, template_id, level, favorite, locked) VALUES ($1,$2,$3,$4,$4) RETURNING instance_id, level",
      [u.id, t.id, isFirst ? 5 : 1, isFirst]
    );
    if (isFirst) {
      const list = await dailyTemplates();
      const commons = list.filter((x) => x.id !== t.id);
      for (let i = 0; i < 2 && commons.length; i++) {
        const c = commons.splice(Math.floor(Math.random() * commons.length), 1)[0];
        const ci = await db.query("INSERT INTO creature_instances (user_id, template_id, level) VALUES ($1,$2,1) RETURNING instance_id", [u.id, c.id]);
        companions.push({ instance_id: ci.rows[0].instance_id, template: c });
      }
    }
  } catch (e) {
    // Devuelve el reclamo si la criatura no llegó a crearse (el usuario podrá reintentar).
    await db.query("UPDATE users SET last_claim_date=$1, daily_streak=$2, coins=coins-30 WHERE id=$3",
      [u.last_claim_date, u.daily_streak, u.id]).catch(() => {});
    throw e;
  }
  await bumpMission(u.id, "claims", 1);
  maybeAureaArt(ins.rows[0].instance_id, t.id); // áurea -> arte dorado perezoso
  res.json({ instance: { instance_id: ins.rows[0].instance_id, level: ins.rows[0].level, template: t }, streak,
    first: isFirst || undefined, companions: isFirst ? companions : undefined,
    duplicate: duplicate || undefined, dust: dust || undefined });
}));

// --------------------------------- ÁLBUM (temporada) -------------------------
// El ÁLBUM mensual: todas las criaturas de la temporada, marcando cuáles posees
// (silueta si no). Es el catálogo coleccionable estable del mes + su progreso y
// la recompensa por completarlo. Marca también el DESTACADO del día (rotación).
const ALBUM_REWARD = { coins: 1000, gems: 30 };
app.get("/season", authMiddleware, wrap(async (req, res) => {
  const today = C.todayStr();
  const sKey = C.seasonKey(today);
  const pool = await seasonTemplates(today);
  const owned = await ownedSeasonIds(req.userId, sKey);
  const hiIds = new Set(C.dailyHighlights(today, pool, HIGHLIGHT_N).map((t) => t.id));
  const claimedKey = "album_" + sKey;
  const rewardClaimed = (await db.query("SELECT 1 FROM achievements WHERE user_id=$1 AND key=$2", [req.userId, claimedKey])).rowCount > 0;
  const entries = pool.map((t) => {
    const have = owned.has(t.id);
    // Las no poseídas se entregan como SILUETA: sin nombre/lore, solo rareza y
    // art_seed (el cliente dibuja la silueta del sprite procedural).
    return have
      ? { id: t.id, owned: true, highlight: hiIds.has(t.id), name: t.name, type: t.type, types: t.types, rarity: t.rarity, ability: t.ability, art_seed: t.art_seed, image_url: t.image_url, image_thumb_url: t.image_thumb_url, base_stats: t.base_stats }
      : { id: t.id, owned: false, highlight: hiIds.has(t.id), rarity: t.rarity, art_seed: t.art_seed };
  });
  res.json({
    season: { key: sKey, label: C.seasonLabel(today) },
    total: pool.length, owned: owned.size,
    complete: owned.size >= pool.length,
    reward: ALBUM_REWARD, rewardClaimed,
    entries,
  });
}));
// Recompensa por completar el álbum del mes (una vez por temporada).
app.post("/season/claim", authMiddleware, wrap(async (req, res) => {
  const sKey = C.seasonKey();
  const pool = await seasonTemplates();
  const owned = await ownedSeasonIds(req.userId, sKey);
  if (owned.size < pool.length) return res.status(400).json({ error: "incomplete", owned: owned.size, total: pool.length });
  const claimedKey = "album_" + sKey;
  // INSERT condicional = barrera atómica anti-doble-cobro.
  const ins = await db.query("INSERT INTO achievements (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key", [req.userId, claimedKey]);
  if (!ins.rowCount) return res.status(400).json({ error: "already_claimed" });
  await db.query("UPDATE users SET coins=coins+$1, gems=gems+$2 WHERE id=$3", [ALBUM_REWARD.coins, ALBUM_REWARD.gems, req.userId]);
  res.json({ reward: ALBUM_REWARD, user: userPublic(await getUser(req.userId)) });
}));

// --------------------------- CRIATURA ÚNICA DEL DÍA --------------------------
// Pieza exclusiva del día (caza/FOMO): una sola criatura, con su propio arte,
// reclamable HOY a cambio de monedas. Mañana cambia: si no la cogiste, la pierdes.
app.get("/daily/unique", authMiddleware, wrap(async (req, res) => {
  const today = C.todayStr();
  const t = await dailyUniqueTemplate(today);
  const owned = (await db.query("SELECT 1 FROM creature_instances WHERE user_id=$1 AND template_id=$2 LIMIT 1", [req.userId, t.id])).rowCount > 0;
  res.json({ date: today, cost: UNIQUE_COST, owned, nextBatchAt: nextBatchAt(),
    creature: { id: t.id, name: t.name, type: t.type, types: t.types, rarity: t.rarity, ability: t.ability, lore: t.lore, art_seed: t.art_seed, image_url: t.image_url, image_thumb_url: t.image_thumb_url, base_stats: t.base_stats } });
}));
app.post("/daily/unique/claim", authMiddleware, wrap(async (req, res) => {
  const today = C.todayStr();
  const t = await dailyUniqueTemplate(today);
  const already = await db.query("SELECT 1 FROM creature_instances WHERE user_id=$1 AND template_id=$2 LIMIT 1", [req.userId, t.id]);
  if (already.rowCount) return res.status(400).json({ error: "already_owned" });
  // Cobro atómico en monedas (UPDATE condicional = sin saldo negativo en carrera).
  const pay = await db.query("UPDATE users SET coins=coins-$1 WHERE id=$2 AND coins>=$1 RETURNING id", [UNIQUE_COST, req.userId]);
  if (!pay.rowCount) return res.status(402).json({ error: "insufficient" });
  let ins;
  try {
    ins = await db.query("INSERT INTO creature_instances (user_id, template_id, favorite) VALUES ($1,$2,true) RETURNING instance_id", [req.userId, t.id]);
  } catch (e) {
    await db.query("UPDATE users SET coins=coins+$1 WHERE id=$2", [UNIQUE_COST, req.userId]).catch(() => {});
    throw e;
  }
  maybeAureaArt(ins.rows[0].instance_id, t.id);
  res.json({ instance: { instance_id: ins.rows[0].instance_id, level: 1, template: t }, user: userPublic(await getUser(req.userId)) });
}));

// -------------------------------- MISSIONS -----------------------------------
app.get("/missions", authMiddleware, wrap(async (req, res) => {
  res.json(await missionsPublic(req.userId));
}));
app.post("/missions/claim", authMiddleware, wrap(async (req, res) => {
  const key = req.body && req.body.key;
  // Misiones SEMANALES (claves w_*): mismo endpoint, lógica en missions.js.
  if (key && key.startsWith("w_")) {
    const out = await weekly.claimWeekly(req.userId, key);
    if (out.error) return res.status(400).json(out);
    return res.json(Object.assign(out, { weeklyMissions: await weekly.weeklyPublic(req.userId) }));
  }
  const def = MISSIONS[key];
  if (!def) return res.status(400).json({ error: "bad_mission" });
  await ensureMissionRow(req.userId);
  const r = await db.query("SELECT * FROM daily_missions WHERE user_id=$1 AND daily_date=$2", [req.userId, C.todayStr()]);
  const m = r.rows[0];
  if (m[def.col] < def.goal) return res.status(400).json({ error: "not_done" });
  if (m[def.flag]) return res.status(400).json({ error: "already_claimed" });
  await db.query(`UPDATE daily_missions SET ${def.flag}=true WHERE user_id=$1 AND daily_date=$2`, [req.userId, C.todayStr()]);
  await db.query("UPDATE users SET coins=coins+$1 WHERE id=$2", [def.reward, req.userId]);
  res.json({ key, reward: def.reward, missions: await missionsPublic(req.userId) });
}));

// -------------------------------- COLLECTION ---------------------------------
app.get("/collection", authMiddleware, wrap(async (req, res) => {
  const r = await db.query(
    `SELECT ci.instance_id, ci.level, ci.xp, ci.favorite, ci.locked, ci.obtained_at, ci.cosmetic_frame, ci.evo_path,
            t.template_id, t.name, t.type, t.type2, t.rarity, t.ability_id, t.lore, t.art_seed,
            t.base_hp, t.base_atk, t.base_def, t.base_spd, t.base_atk_p, t.base_atk_s, t.base_def_p, t.base_def_s,
            t.image_url, t.image_thumb_url
       FROM creature_instances ci JOIN creature_templates t ON t.template_id=ci.template_id
      WHERE ci.user_id=$1 ORDER BY ci.obtained_at DESC`,
    [req.userId]
  );
  // Arte IA de VARIANTES (evolución/áurea) ya generado: una sola query por las
  // filas "<tplId>__evoN|__aurea" que apliquen a esta colección.
  const artIds = new Set();
  for (const x of r.rows) {
    const stage = C.evoStageAt(x.template_id, x.level);
    if (stage > 0) artIds.add(C.variantArtId(x.template_id, "evo" + stage));
    if (C.variantOf(x.instance_id) === "aurea") artIds.add(C.variantArtId(x.template_id, "aurea"));
  }
  const artById = {};
  if (artIds.size) {
    const ar = await db.query("SELECT template_id, image_url FROM creature_templates WHERE template_id = ANY($1) AND image_url IS NOT NULL", [[...artIds]]);
    ar.rows.forEach((a) => (artById[a.template_id] = a.image_url));
  }
  res.json(r.rows.map((x) => {
    const b = tplBaseStats(x);
    const iv = C.ivFor(x.instance_id);
    const variant = C.variantOf(x.instance_id);
    const stage = C.evoStageAt(x.template_id, x.level);
    const em = C.evoPowerMult(x.template_id, x.level);
    const sc = (k) => Math.round(C.scaled(b[k], x.level) * em);
    const stats = { hp: sc("hp"), atkP: sc("atkP"), atkS: sc("atkS"), defP: sc("defP"), defS: sc("defS"), spd: sc("spd") };
    // Sendero de evolución: aplica el perfil a las stats mostradas (combate lo
    // revalida aparte). Solo si la criatura ya evolucionó (stage>0).
    const pathDef = stage > 0 && x.evo_path && C.EVO_PATHS[x.evo_path] ? C.EVO_PATHS[x.evo_path] : null;
    if (pathDef) {
      stats.atkP = Math.round(stats.atkP * pathDef.atk); stats.atkS = Math.round(stats.atkS * pathDef.atk);
      stats.defP = Math.round(stats.defP * pathDef.def); stats.defS = Math.round(stats.defS * pathDef.def);
      stats.hp = Math.round(stats.hp * pathDef.hp); stats.spd = Math.round(stats.spd * pathDef.spd);
    }
    return {
      instance_id: x.instance_id, level: x.level, favorite: x.favorite, locked: x.locked,
      obtained_at: x.obtained_at, // para el badge NUEVO (obtenido hoy) del cliente
      frame: x.cosmetic_frame,
      // Sendero elegido (solo relevante si stage>0); null si aún no eligió.
      evo_path: stage > 0 ? (x.evo_path || null) : null,
      can_choose_path: stage > 0 && !x.evo_path, // el cliente ofrece elegir
      // Singularidad por instancia: "potencial" (media de IV 0..100) y variante
      // cosmética (áurea/prismática). template.base_stats se mantiene PURO (caché
      // compartida); el cliente aplica los IV con el instance_id para mostrarlas.
      potential: iv ? iv.potential : null,
      variant,
      // Evolución actual (derivada de plantilla+nivel) + arte IA si ya existe.
      evo: stage > 0 ? { stage, name: C.evoName(x.name, x.template_id, stage),
        image_url: artById[C.variantArtId(x.template_id, "evo" + stage)] || null } : null,
      shiny_image_url: variant === "aurea" ? (artById[C.variantArtId(x.template_id, "aurea")] || null) : null,
      template: {
        id: x.template_id, name: x.name, type: x.type, types: tplTypes(x), rarity: x.rarity, ability: x.ability_id,
        lore: x.lore, art_seed: x.art_seed, image_url: x.image_url, image_thumb_url: x.image_thumb_url,
        base_stats: b,
        // stats escaladas con la EVOLUCIÓN (+ sendero) incluida (el cliente aplica IV encima).
        stats,
      },
    };
  }));
}));

app.post("/creature/:id/level-up", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT * FROM creature_instances WHERE instance_id=$1 AND user_id=$2", [req.params.id, req.userId]);
  const inst = r.rows[0];
  if (!inst) return res.status(404).json({ error: "not_found" });
  if (inst.level >= C.LEVEL_MAX) return res.status(400).json({ error: "max_level" });
  const cost = C.levelCost(inst.level);
  // Cobro atómico: el UPDATE condicional evita saldos negativos con peticiones
  // concurrentes (antes: leer saldo -> comprobar -> restar, con carrera).
  const pay = await db.query(
    "UPDATE users SET dust=dust-$1, coins=coins-$2 WHERE id=$3 AND dust>=$1 AND coins>=$2 RETURNING id",
    [cost.dust, cost.coins, req.userId]
  );
  if (!pay.rowCount) return res.status(402).json({ error: "insufficient" });
  // Sube solo si sigue por debajo del máximo (carrera entre dos level-up).
  const up = await db.query(
    "UPDATE creature_instances SET level=level+1 WHERE instance_id=$1 AND level<$2 RETURNING level",
    [inst.instance_id, C.LEVEL_MAX]
  );
  if (!up.rowCount) { // devolver el cobro si otra petición llegó antes al máximo
    await db.query("UPDATE users SET dust=dust+$1, coins=coins+$2 WHERE id=$3", [cost.dust, cost.coins, req.userId]);
    return res.status(400).json({ error: "max_level" });
  }
  const newLevel = up.rows[0].level;
  // ¿EVOLUCIONÓ con esta subida? (automático al cruzar el umbral del aigron).
  let evolved;
  const before = C.evoStageAt(inst.template_id, newLevel - 1);
  const after = C.evoStageAt(inst.template_id, newLevel);
  if (after > before) {
    const base = await tplById(inst.template_id);
    if (base) variantArt.ensureVariantArtAsync(base, "evo" + after); // red de seguridad si el pregen no llegó
    evolved = { stage: after, name: C.evoName(base ? base.name : "", inst.template_id, after), at: newLevel };
  }
  // CALENTAMIENTO: si la próxima evolución está a <=2 niveles, pregenera ya su
  // arte (además del pregen nocturno del álbum): cuando el jugador cruce el
  // umbral, la imagen estará lista y la evolución se ve con su arte al instante.
  const next = C.evoNext(inst.template_id, newLevel);
  if (next && next.at - newLevel <= 2) {
    tplById(inst.template_id)
      .then((base) => { if (base) variantArt.ensureVariantArtAsync(base, "evo" + next.stage); })
      .catch(() => {});
  }
  res.json({ level: newLevel, cost, evolved });
}));

app.post("/creature/:id/release", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT ci.*, t.rarity FROM creature_instances ci JOIN creature_templates t ON t.template_id=ci.template_id WHERE ci.instance_id=$1 AND ci.user_id=$2", [req.params.id, req.userId]);
  const inst = r.rows[0];
  if (!inst) return res.status(404).json({ error: "not_found" });
  if (inst.locked) return res.status(400).json({ error: "locked" });
  const team = await db.query("SELECT 1 FROM teams WHERE user_id=$1 AND (slot1=$2 OR slot2=$2 OR slot3=$2)", [req.userId, inst.instance_id]);
  if (team.rowCount) return res.status(400).json({ error: "in_team" });
  // Las variantes cosméticas valen más al liberar (áurea ×4, prismática ×2):
  // así no "duele" tener un duplicado especial y la rareza se premia.
  const variant = C.variantOf(inst.instance_id);
  const VARIANT_MULT = { aurea: 4, prismatica: 2 };
  const dust = Math.round((C.RELEASE_DUST[inst.rarity] || 5) * (VARIANT_MULT[variant] || 1));
  // El DELETE condicionado a locked=false es la barrera atómica: si dos
  // peticiones liberan a la vez, solo la que borra la fila cobra el polvo.
  const del = await db.query(
    "DELETE FROM creature_instances WHERE instance_id=$1 AND user_id=$2 AND locked=false RETURNING instance_id",
    [inst.instance_id, req.userId]
  );
  if (!del.rowCount) return res.status(400).json({ error: "locked" });
  await db.query("UPDATE users SET dust=dust+$1 WHERE id=$2", [dust, req.userId]);
  res.json({ dust });
}));

app.post("/creature/:id/favorite", authMiddleware, wrap(async (req, res) => {
  const r = await db.query(
    "UPDATE creature_instances SET favorite = NOT favorite, locked = NOT favorite WHERE instance_id=$1 AND user_id=$2 RETURNING favorite, locked",
    [req.params.id, req.userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  res.json(r.rows[0]);
}));

// Sendero de evolución (#6): el jugador elige el perfil de stats de su forma
// evolucionada. Solo válido si la instancia YA evolucionó (stage>0). Reescribible.
app.post("/creature/:id/evo-path", authMiddleware, wrap(async (req, res) => {
  const path = req.body && req.body.path;
  if (!C.EVO_PATHS[path]) return res.status(400).json({ error: "bad_path" });
  const r = await db.query("SELECT template_id, level FROM creature_instances WHERE instance_id=$1 AND user_id=$2", [req.params.id, req.userId]);
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  if (C.evoStageAt(r.rows[0].template_id, r.rows[0].level) <= 0) return res.status(400).json({ error: "not_evolved" });
  await db.query("UPDATE creature_instances SET evo_path=$1 WHERE instance_id=$2 AND user_id=$3", [path, req.params.id, req.userId]);
  res.json({ evo_path: path });
}));

// ----------------------------------- TEAM ------------------------------------
app.get("/team", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT slot1,slot2,slot3 FROM teams WHERE user_id=$1", [req.userId]);
  res.json(r.rows[0] || { slot1: null, slot2: null, slot3: null });
}));

app.put("/team", authMiddleware, wrap(async (req, res) => {
  const slots = (req.body && req.body.slots) || [];
  if (!Array.isArray(slots)) return res.status(400).json({ error: "bad_slots" });
  const own = await db.query("SELECT instance_id, level, template_id, evo_path FROM creature_instances WHERE user_id=$1 AND instance_id = ANY($2::uuid[])", [req.userId, slots]);
  const valid = own.rows.map((x) => x.instance_id);
  const ordered = slots.filter((s) => valid.includes(s)).slice(0, 3);
  // instance_id en el snapshot: el rival aplica MIS IV al defenderme (consistencia
  // atacante/defensor). Snapshots antiguos sin él -> stats de plantilla puras.
  // evo_path viaja en el snapshot para que mi sendero cuente al defenderme async.
  const snapshot = own.rows
    .filter((x) => ordered.includes(x.instance_id))
    .map((x) => ({ template_id: x.template_id, level: x.level, instance_id: x.instance_id, evo_path: x.evo_path || null }));
  // avg_level materializado: el matchmaking de /battle/find filtra por esta
  // columna indexada en vez de calcular avg() sobre el JSONB de TODOS los equipos.
  const avgLevel = snapshot.length ? snapshot.reduce((a, s) => a + s.level, 0) / snapshot.length : null;
  await db.query(
    `INSERT INTO teams (user_id, slot1, slot2, slot3, snapshot, avg_level, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (user_id) DO UPDATE SET slot1=$2, slot2=$3, slot3=$4, snapshot=$5, avg_level=$6, updated_at=now()`,
    [req.userId, ordered[0] || null, ordered[1] || null, ordered[2] || null, JSON.stringify(snapshot), avgLevel]
  );
  res.json({ slots: ordered });
}));

// ---------------------------------- BATTLE -----------------------------------
// Construye unidades B desde el snapshot de un equipo de otro jugador.
async function opponentFromSnapshot(snapshot) {
  // snapshot: [{template_id, level}]
  const ids = snapshot.map((s) => s.template_id);
  const r = await db.query(
    "SELECT template_id, name, type, type2, ability_id, base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s, image_url, image_thumb_url FROM creature_templates WHERE template_id = ANY($1)",
    [ids]
  );
  const byId = {}; r.rows.forEach((x) => (byId[x.template_id] = x));
  const out = [];
  snapshot.forEach((s, i) => {
    const t = byId[s.template_id];
    if (!t) return;
    const tplLike = { id: t.template_id, name: t.name, type: t.type, types: tplTypes(t), ability: t.ability_id, base_stats: C.applyIV(tplBaseStats(t), s.instance_id) };
    const u = combat.buildUnit(tplLike, s.level, "B", out.length);
    if (s.evo_path && u.evoStage > 0) C.applyEvoPath(u, s.evo_path); // sendero del defensor
    u.imageUrl = t.image_url; u.imageThumbUrl = t.image_thumb_url;
    out.push(u);
  });
  return out;
}

const STANCES_OK = ["NEUTRAL", "AGRESIVA", "DEFENSIVA"];
// Ventana de emparejamiento PvP por nivel medio de equipo (±). Fuera de rango -> bot.
const MATCH_LEVEL_WINDOW = 15;
app.post("/battle/find", authMiddleware, wrap(async (req, res) => {
  const A = await buildTeamUnits(req.userId);
  if (!A.length) return res.status(400).json({ error: "empty_team" });
  const lvl = teamAvgLevel(A);
  const seed = (Math.random() * 0x7fffffff) | 0;

  // Capitán + estancia (decisión previa del jugador): se hornean en los stats de A.
  const captainUid = req.body && req.body.captain ? (A.find((u) => u.instanceId === req.body.captain) || {}).uid : null;
  const stance = req.body && STANCES_OK.includes(req.body.stance) ? req.body.stance : "NEUTRAL";
  C.applyCaptainStance(A, captainUid, stance);
  C.applyTeamSynergy(A); // bono de composición de tipos (horneado, revalidado)

  const me = await getUser(req.userId);

  // PvP asíncrono: busca el snapshot de un rival de NIVEL similar (ventana dura),
  // desempatando por cercanía de liga; si no hay nadie en rango, bot (que escala
  // al nivel del atacante -> combate siempre justo).
  let B = [];
  let defenderId = null;
  // COALESCE: equipos guardados antes de existir avg_level siguen siendo
  // candidatos (se calcula al vuelo solo para ellos hasta que re-guarden).
  const rival = await db.query(
    `WITH cand AS (
       SELECT t.user_id, t.snapshot, u.league_points,
              COALESCE(t.avg_level,
                       (SELECT avg((e->>'level')::numeric) FROM jsonb_array_elements(t.snapshot) e)) AS lvl
         FROM teams t JOIN users u ON u.id = t.user_id
        WHERE t.user_id <> $1 AND t.snapshot IS NOT NULL AND jsonb_array_length(t.snapshot) > 0
     )
     SELECT user_id, snapshot FROM cand
      WHERE lvl IS NOT NULL AND abs(lvl - $2) <= $3
      ORDER BY abs(lvl - $2) ASC, abs(league_points - $4) ASC, random()
      LIMIT 10`,
    [req.userId, lvl, MATCH_LEVEL_WINDOW, me.league_points]
  );
  if (rival.rowCount) {
    const pick = rival.rows[Math.floor(Math.random() * rival.rowCount)];
    B = await opponentFromSnapshot(pick.snapshot);
    if (B.length) defenderId = pick.user_id;
  }
  if (!B.length) {
    const tpls = await todayTemplates();
    B = combat.botTeamFromSeed(seed, tpls, lvl);
  }
  // El rival lucha con un capitán neutral (liderazgo) para no quedar en desventaja.
  C.applyCaptainStance(B, B[0] && B[0].uid, "NEUTRAL");
  C.applyTeamSynergy(B);

  // "Congela" la oferta (ambos equipos) para recalcular seguro en /resolve.
  const offer = await db.query(
    "INSERT INTO battle_offers (attacker_id, defender_id, seed, opponent) VALUES ($1,$2,$3,$4) RETURNING id",
    [req.userId, defenderId, seed, JSON.stringify({ team: A.map(publicUnit), opponent: B.map(publicUnit) })]
  );

  res.json({ battleId: offer.rows[0].id, seed, opponent: B.map(publicUnit), team: A.map(publicUnit), pvp: !!defenderId });
}));

app.post("/battle/resolve", authMiddleware, wrap(async (req, res) => {
  const { battleId, decisions = [] } = req.body || {};
  if (!battleId) return res.status(400).json({ error: "battleId_required" });
  if (!Array.isArray(decisions)) return res.status(400).json({ error: "bad_decisions" });
  // Saneado: el cliente solo controla unidades 'A...'; el resto se normaliza.
  const safeDecisions = decisions
    .filter((d) => d && Number.isInteger(d.turn) && typeof d.uid === "string" && d.uid[0] === "A")
    .slice(0, 600)
    .map((d) => ({
      turn: d.turn,
      uid: d.uid,
      action: d.action === "guard" ? "guard" : d.action === "attack" ? "attack" : "ability",
      target: typeof d.target === "string" ? d.target : undefined,
      overcharge: !!d.overcharge,
    }));

  let u = await getUser(req.userId);
  u = await syncEnergy(u);
  if (u.energy < 1) return res.status(402).json({ error: "no_energy" });

  // Consume la oferta ANTES de resolver y pagar: el UPDATE condicional es la
  // barrera atómica (dos /resolve concurrentes con el mismo battleId -> solo
  // uno cobra). Antes se marcaba consumida después, con carrera explotable.
  const off = await db.query(
    "UPDATE battle_offers SET consumed=true WHERE id=$1 AND attacker_id=$2 AND consumed=false RETURNING *",
    [battleId, req.userId]
  );
  if (!off.rowCount) return res.status(404).json({ error: "offer_not_found" });
  const offer = off.rows[0];

  // Reconstruye AMBOS equipos desde la oferta congelada (igual que vio el cliente).
  const frozen = offer.opponent; // { team:[...], opponent:[...] }
  const A = frozen.team.map((s, i) => combat.unitFromStats(s, "A", i));
  const B = frozen.opponent.map((s, i) => combat.unitFromStats(s, "B", i));

  const result = combat.resolveBattle(A, B, offer.seed | 0, safeDecisions);
  const win = result.winner === "A";
  const abilitiesUsed = result.log.filter((e) => e.ability && e.uid[0] === "A").length;

  // Replay: equipos congelados + log + estado final (suficiente para reproducir).
  const snapEnd = (team) => team.map((x) => ({ uid: x.uid, hp: Math.round(x.hp) }));
  const replay = { you: "A", team: frozen.team, opponent: frozen.opponent, log: result.log,
    end: { A: snapEnd(A), B: snapEnd(B) } };
  const award = await awardBattleResult({ user: u, win, abilitiesUsed, defenderId: offer.defender_id, seed: offer.seed | 0, replay });

  res.json({ win, coins: award.coins, leaguePoints: award.leaguePoints, league: award.league, energy: award.energy, log: result.log, turns: result.turns, pvp: !!offer.defender_id });
}));

// Aplica el resultado de un combate a un usuario: monedas, puntos de liga (±),
// energía −1, registro en `battles`, `daily_scores` y misiones. Reutilizado por el
// combate PvE (/battle/resolve) y por el PvP en vivo (pvp.js, ambos jugadores).
// `user` debe venir ya con la energía sincronizada (syncEnergy).
async function awardBattleResult({ user, win, abilitiesUsed = 0, defenderId = null, seed = 0, replay = null }) {
  const coins = win ? 40 : 8;
  const lpDelta = win ? 12 : -6;
  // Deltas atómicos en SQL (no valores absolutos leídos antes): dos combates
  // concurrentes del mismo usuario no se pisan ni duplican recompensas.
  const upd = await db.query(
    `UPDATE users SET
       coins = coins + $1,
       league_points = GREATEST(league_points + $2, 0),
       energy_updated_at = CASE WHEN GREATEST(energy - 1, 0) < $3 THEN now() ELSE energy_updated_at END,
       energy = GREATEST(energy - 1, 0),
       total_wins = total_wins + $5,
       total_losses = total_losses + $6
     WHERE id = $4
     RETURNING energy, league_points`,
    [coins, lpDelta, C.ENERGY_MAX, user.id, win ? 1 : 0, win ? 0 : 1]
  );
  const newEnergy = upd.rows[0].energy;
  const newLp = upd.rows[0].league_points;
  const league = C.computeLeague(newLp);
  // `best_league` alimenta perfil, logros y marcos cosméticos.
  await db.query(
    `UPDATE users SET league=$1,
       best_league = CASE WHEN ${leagueOrdSql("$1")} > ${leagueOrdSql("best_league")} THEN $1 ELSE best_league END
     WHERE id=$2`,
    [league, user.id]
  );
  await db.query("INSERT INTO battles (attacker_id, defender_id, seed, result, daily_date, replay) VALUES ($1,$2,$3,$4,$5,$6)",
    [user.id, defenderId, seed | 0, win ? "WIN" : "LOSS", C.todayStr(), replay ? JSON.stringify(replay) : null]);
  if (win) await weekly.bumpWeekly(user.id, "w_wins", 1);
  if (win) {
    await db.query(
      `INSERT INTO daily_scores (daily_date, user_id, wins) VALUES ($1,$2,1)
       ON CONFLICT (daily_date, user_id) DO UPDATE SET wins = daily_scores.wins + 1`,
      [C.todayStr(), user.id]
    );
    await bumpMission(user.id, "wins", 1);
  }
  if (abilitiesUsed > 0) await bumpMission(user.id, "abilities", abilitiesUsed);
  return { coins, leaguePoints: newLp, league, energy: newEnergy };
}

// --------------------------------- RANKINGS ----------------------------------
// Ambos rankings devuelven { rows, me }: `me` trae tu posición real aunque no
// estés en el top 50 (el cliente la ancla abajo — es lo que el jugador busca).
// El TOP compartido se CACHEA (cambia poco y lo pide todo el mundo): a escala,
// recalcular el top-50 por petición es matar la BD para nada.
const _rankCache = new Map();
async function cached(key, ms, fn) {
  const e = _rankCache.get(key);
  if (e && Date.now() - e.at < ms) return e.v;
  const v = await fn();
  _rankCache.set(key, { at: Date.now(), v });
  return v;
}
const RANK_CACHE_MS = parseInt(process.env.RANK_CACHE_MS || "30000", 10);
app.get("/rankings/daily", authMiddleware, wrap(async (req, res) => {
  const today = C.todayStr();
  const top = await cached("daily:" + today, RANK_CACHE_MS, async () => {
    const r = await db.query(
      `SELECT u.display_name AS name, ds.wins, ds.user_id
         FROM daily_scores ds JOIN users u ON u.id=ds.user_id
        WHERE ds.daily_date=$1 ORDER BY ds.wins DESC LIMIT 50`,
      [today]
    );
    return r.rows;
  });
  const rows = top.map((x, i) => ({ pos: i + 1, name: x.name, score: x.wins, me: x.user_id === req.userId }));
  let me = rows.find((x) => x.me) || null;
  if (!me) {
    const mine = await db.query("SELECT wins FROM daily_scores WHERE daily_date=$1 AND user_id=$2", [today, req.userId]);
    if (mine.rowCount) {
      const pos = await db.query("SELECT COUNT(*)::int AS n FROM daily_scores WHERE daily_date=$1 AND wins > $2", [today, mine.rows[0].wins]);
      me = { pos: pos.rows[0].n + 1, score: mine.rows[0].wins };
    }
  }
  res.json({ rows, me, closeAt: leagues.nextCloseAt() });
}));
app.get("/rankings/league", authMiddleware, wrap(async (req, res) => {
  const top = await cached("league", RANK_CACHE_MS, async () => {
    const r = await db.query("SELECT id, display_name AS name, league, league_points FROM users ORDER BY league_points DESC LIMIT 50");
    return r.rows;
  });
  const rows = top.map((x, i) => ({ pos: i + 1, name: x.name, league: x.league, score: x.league_points, me: x.id === req.userId }));
  let me = rows.find((x) => x.me) || null;
  if (!me) {
    const u = await getUser(req.userId);
    const pos = await db.query("SELECT COUNT(*)::int AS n FROM users WHERE league_points > $1", [u.league_points]);
    me = { pos: pos.rows[0].n + 1, score: u.league_points, league: u.league };
  }
  res.json({ rows, me, closeAt: leagues.nextCloseAt(), rewards: leagues.REWARDS });
}));

// ----------------------------------- SHOP ------------------------------------
app.post("/shop/roll", authMiddleware, wrap(async (req, res) => {
  const today = C.todayStr();
  const u = await getUser(req.userId);
  if (!u.rolls_date || C.todayStr(new Date(u.rolls_date)) !== today) {
    // Reset diario (idempotente: ejecutarlo dos veces no hace daño).
    await db.query("UPDATE users SET rolls_today=0, rolls_date=$1 WHERE id=$2", [today, u.id]);
  }
  // Cobro + contador ATÓMICOS antes de crear la criatura: con peticiones
  // concurrentes no se supera el techo de 10/día ni el saldo queda negativo.
  const pay = await db.query(
    `UPDATE users SET coins=coins-100, rolls_today=rolls_today+1
      WHERE id=$1 AND rolls_date=$2 AND rolls_today<10 AND coins>=100
      RETURNING rolls_today`,
    [u.id, today]
  );
  if (!pay.rowCount) {
    const now = await getUser(req.userId);
    if (now.rolls_today >= 10) return res.status(429).json({ error: "daily_cap" });
    return res.status(402).json({ error: "insufficient" });
  }
  // Tirada del álbum con sesgo al destacado + pity + polvo por duplicado.
  const drawn = await drawFromSeason(u);
  const t = drawn.template;
  let ins;
  try {
    ins = await db.query("INSERT INTO creature_instances (user_id, template_id) VALUES ($1,$2) RETURNING instance_id", [u.id, t.id]);
  } catch (e) {
    // Reembolsa si la criatura no llegó a crearse.
    await db.query("UPDATE users SET coins=coins+100, rolls_today=GREATEST(rolls_today-1,0) WHERE id=$1", [u.id]).catch(() => {});
    throw e;
  }
  maybeAureaArt(ins.rows[0].instance_id, t.id);
  res.json({ instance_id: ins.rows[0].instance_id, template: t, duplicate: drawn.duplicate || undefined, dust: drawn.dust || undefined });
}));

// Compra de gemas / pase (dinero real): en producción valida el recibo de
// tienda (App Store / Google Play) antes de conceder; aquí stub por env.
// La recarga de energía se paga con GEMAS (moneda virtual, sin recibo): es el
// primer uso real de las gemas dentro del juego.
const GEMS_ENERGY_REFILL = 20;
app.post("/shop/purchase", authMiddleware, wrap(async (req, res) => {
  const { sku } = req.body || {};
  if (sku === "energy_refill") {
    // Cobro atómico en gemas (sin carrera: el UPDATE condicional es la barrera).
    const r = await db.query(
      "UPDATE users SET gems=gems-$1, energy=$2, energy_updated_at=now() WHERE id=$3 AND gems>=$1 AND energy<$2 RETURNING id",
      [GEMS_ENERGY_REFILL, C.ENERGY_MAX, req.userId]
    );
    if (!r.rowCount) {
      const u0 = await getUser(req.userId);
      return res.status(402).json({ error: u0.energy >= C.ENERGY_MAX ? "energy_full" : "insufficient_gems" });
    }
    return res.json(userPublic(await getUser(req.userId)));
  }
  const CATALOG = { gems_small: { gems: 50 }, pass: { gems: 20, pass: true } };
  const item = CATALOG[sku];
  if (!item) return res.status(400).json({ error: "bad_sku" });
  if (process.env.ALLOW_STUB_PURCHASES !== "true") {
    return res.status(501).json({ error: "receipt_validation_required" });
  }
  if (item.gems) await db.query("UPDATE users SET gems=gems+$1 WHERE id=$2", [item.gems, req.userId]);
  const u = await getUser(req.userId);
  res.json(userPublic(u));
}));

// ---------------------------------- FUSION -----------------------------------
app.post("/fusion", authMiddleware, wrap(async (req, res) => {
  const { a, b } = req.body || {};
  if (!a || !b || a === b) return res.status(400).json({ error: "need_two_distinct" });
  try {
    const out = await fuse(req.userId, a, b);
    await db.query("UPDATE users SET fusions_done=fusions_done+1 WHERE id=$1", [req.userId]);
    await weekly.bumpWeekly(req.userId, "w_fusions", 1);
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// --------------------------------- DUNGEON -----------------------------------
const dungeonErr = (res, e) => res.status(400).json({ error: e.message });
app.post("/dungeon/start", authMiddleware, wrap(async (req, res) => {
  try {
    const A = await buildTeamUnits(req.userId);
    res.json(await dungeon.startRun(req.userId, A, req.body && req.body.difficulty));
  } catch (e) { dungeonErr(res, e); }
}));
app.get("/dungeon", authMiddleware, wrap(async (req, res) => {
  res.json(await dungeon.getRun(req.userId) || { status: "none" });
}));
app.post("/dungeon/choose", authMiddleware, wrap(async (req, res) => {
  try {
    const tpls = await todayTemplates();
    res.json(await dungeon.chooseNode(req.userId, (req.body && req.body.choice) | 0, tpls));
  } catch (e) { dungeonErr(res, e); }
}));
app.post("/dungeon/battle", authMiddleware, wrap(async (req, res) => {
  try { res.json(await dungeon.resolveCombat(req.userId, (req.body && req.body.decisions) || [])); }
  catch (e) { dungeonErr(res, e); }
}));
// Huir = perder la run (permadeath): sin esto, huir permitiría reintentar
// gratis cualquier combate perdido de la mazmorra.
app.post("/dungeon/abandon", authMiddleware, wrap(async (req, res) => {
  try { res.json(await dungeon.abandonRun(req.userId)); }
  catch (e) { dungeonErr(res, e); }
}));
app.post("/dungeon/draft", authMiddleware, wrap(async (req, res) => {
  try {
    if (req.body && req.body.skip) res.json(await dungeon.skipDraft(req.userId));
    else res.json(await dungeon.draftRelic(req.userId, (req.body && req.body.choice) | 0));
  } catch (e) { dungeonErr(res, e); }
}));
app.post("/dungeon/shop", authMiddleware, wrap(async (req, res) => {
  try { res.json(await dungeon.shopAction(req.userId, req.body && req.body.action, (req.body && req.body.arg) | 0)); }
  catch (e) { dungeonErr(res, e); }
}));
app.get("/dungeon/ranking", authMiddleware, wrap(async (req, res) => {
  res.json(await dungeon.ranking(req.userId, (req.query && req.query.difficulty) || "NORMAL"));
}));

// ---------------------------- PERFIL / REPLAYS -------------------------------
app.get("/profile", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  if (!u) return res.status(404).json({ error: "no_user" });
  const col = await db.query("SELECT COUNT(*)::int AS n FROM creature_instances WHERE user_id=$1", [u.id]);
  const weeks = await db.query(
    "SELECT week_start, league, points FROM league_weeks WHERE user_id=$1 ORDER BY week_start DESC LIMIT 8", [u.id]);
  const recent = await db.query(
    `SELECT b.id, b.result, b.created_at, b.defender_id IS NOT NULL AS pvp, b.replay IS NOT NULL AS has_replay,
            d.display_name AS opp_name
       FROM battles b LEFT JOIN users d ON d.id = b.defender_id
      WHERE b.attacker_id=$1 ORDER BY b.created_at DESC LIMIT 10`, [u.id]);
  res.json({
    displayName: u.display_name, createdAt: u.created_at,
    totalWins: u.total_wins, totalLosses: u.total_losses,
    bestStreak: u.best_streak, streak: u.daily_streak,
    league: u.league, leaguePoints: u.league_points, bestLeague: u.best_league,
    dungeonsCleared: u.dungeons_cleared, fusionsDone: u.fusions_done,
    collectionCount: col.rows[0].n,
    weeks: weeks.rows,
    recent: recent.rows.map((b) => ({ id: b.id, result: b.result, at: b.created_at, pvp: b.pvp, hasReplay: b.has_replay, oppName: b.opp_name })),
  });
}));
// RECAP mensual estilo "Wrapped": resumen compartible de la temporada (mes) del
// jugador. Reúne descubrimientos del mes, distribución por tipo/rareza, el mejor
// aigrón (por poder base) y los totales de progreso. Datos para una secuencia de
// tarjetas animadas + una imagen para compartir (viralidad emocional al rotar el
// álbum). Todo derivado de tablas existentes; sin migración.
app.get("/recap", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  if (!u) return res.status(404).json({ error: "no_user" });
  const today = C.todayStr();
  const sKey = C.seasonKey(today);

  // Distribución por rareza y tipo sobre PLANTILLAS DISTINTAS descubiertas (toda
  // la vida): refleja "qué especies conoces", no cuántos duplicados tienes.
  const distinct = await db.query(
    `SELECT DISTINCT t.template_id, t.rarity, t.type
       FROM creature_instances ci JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.user_id=$1`, [req.userId]);
  const rarity = { COMUN: 0, RARA: 0, EPICA: 0, LEGENDARIA: 0 };
  const types = {};
  for (const r of distinct.rows) {
    if (rarity[r.rarity] != null) rarity[r.rarity]++;
    types[r.type] = (types[r.type] || 0) + 1;
  }
  const topType = Object.entries(types).sort((a, b) => b[1] - a[1])[0] || null;

  // Totales de colección + cuántos aigrons nuevos este MES (created_at en el mes).
  const counts = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE obtained_at >= date_trunc('month', now()))::int AS new_month
       FROM creature_instances WHERE user_id=$1`, [req.userId]);

  // El mejor aigrón por PODER base (escalado suave por nivel) para la portada.
  // TPL_COLS cualificado con el alias `t.`: en el JOIN, `template_id` existe en
  // ambas tablas y sin cualificar sería ambiguo.
  const tplColsT = TPL_COLS.split(",").map((c) => "t." + c).join(",");
  const topRow = await db.query(
    `SELECT ${tplColsT}, ci.level,
            (t.base_hp/10.0 + t.base_atk_p + t.base_atk_s + t.base_def_p + t.base_def_s + t.base_spd)
            * (1 + (ci.level - 1) * 0.07) AS power
       FROM creature_instances ci JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.user_id=$1 ORDER BY power DESC LIMIT 1`, [req.userId]);
  let top = null;
  if (topRow.rowCount) {
    const t = rowToTpl(topRow.rows[0]);
    top = { id: t.id, name: t.name, type: t.type, types: t.types, rarity: t.rarity,
      ability: t.ability, art_seed: t.art_seed, image_url: t.image_url, image_thumb_url: t.image_thumb_url,
      base_stats: t.base_stats, level: topRow.rows[0].level };
  }

  // Progreso del álbum del mes.
  const pool = await seasonTemplates(today);
  const owned = await ownedSeasonIds(req.userId, sKey);

  res.json({
    season: { key: sKey, label: C.seasonLabel(today) },
    memberSince: u.created_at,
    collection: counts.rows[0].total,
    newThisMonth: counts.rows[0].new_month,
    discovered: distinct.rowCount,
    rarity, types,
    topType: topType ? { type: topType[0], count: topType[1] } : null,
    albumOwned: owned.size, albumTotal: pool.length, complete: pool.length > 0 && owned.size >= pool.length,
    top,
    wins: u.total_wins, losses: u.total_losses,
    streak: u.daily_streak, bestStreak: u.best_streak,
    league: u.league, bestLeague: u.best_league,
    dungeonsCleared: u.dungeons_cleared, fusionsDone: u.fusions_done,
  });
}));
// Cambio de nombre (3-16 caracteres razonables, saneado contra HTML).
app.post("/me/name", authMiddleware, wrap(async (req, res) => {
  const name = auth.sanitizeName((req.body && req.body.name) || "");
  if (!/^[\p{L}\p{N} _.\-·]{3,16}$/u.test(name)) return res.status(400).json({ error: "bad_name" });
  await db.query("UPDATE users SET display_name=$1 WHERE id=$2", [name, req.userId]);
  res.json({ displayName: name });
}));
// Replay de un combate propio (combate determinista grabado: equipos+log+final).
app.get("/battle/:id/replay", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT replay FROM battles WHERE id=$1 AND attacker_id=$2", [req.params.id, req.userId]);
  if (!r.rowCount || !r.rows[0].replay) return res.status(404).json({ error: "no_replay" });
  res.json(r.rows[0].replay);
}));
// Salón de la fama: top de la ÚLTIMA semana cerrada.
app.get("/hall-of-fame", authMiddleware, wrap(async (req, res) => {
  const wk = await db.query("SELECT MAX(week_start) AS w FROM league_weeks");
  if (!wk.rows[0].w) return res.json({ week: null, rows: [] });
  const r = await db.query(
    `SELECT lw.league, lw.points, u.display_name AS name, lw.user_id
       FROM league_weeks lw JOIN users u ON u.id = lw.user_id
      WHERE lw.week_start=$1 ORDER BY lw.points DESC LIMIT 10`, [wk.rows[0].w]);
  res.json({ week: C.todayStr(new Date(wk.rows[0].w)),
    rows: r.rows.map((x, i) => ({ pos: i + 1, name: x.name, league: x.league, score: x.points, me: x.user_id === req.userId })) });
}));

// ------------------------- CONSTELACIONES (gremios, #1) ----------------------
app.get("/guild", authMiddleware, wrap(async (req, res) => { res.json(await guilds.myGuild(req.userId)); }));
app.get("/guild/list", authMiddleware, wrap(async (req, res) => { res.json({ rows: await guilds.listGuilds(30), cost: guilds.GUILD_COST, max: guilds.GUILD_MAX_MEMBERS }); }));
app.post("/guild/create", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.createGuild(req.userId, req.body && req.body.name, req.body && req.body.tag);
  if (out.error) return res.status(400).json(out);
  res.json(Object.assign(out, { user: userPublic(await getUser(req.userId)) }));
}));
app.post("/guild/join", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.joinGuild(req.userId, req.body && req.body.id);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
app.post("/guild/leave", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.leaveGuild(req.userId);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
app.get("/guild/weekly", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.guildWeekly(req.userId);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
app.post("/guild/weekly/claim", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.claimGuildWeekly(req.userId);
  if (out.error) return res.status(400).json(out);
  res.json(Object.assign(out, { user: userPublic(await getUser(req.userId)) }));
}));
app.get("/guild/wall", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.listMessages(req.userId);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
app.post("/guild/wall", authMiddleware, wrap(async (req, res) => {
  const out = await guilds.postMessage(req.userId, req.body && req.body.body);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));

// ------------------------------ TRUEQUE (#2) ---------------------------------
app.get("/trades", authMiddleware, wrap(async (req, res) => {
  res.json({ market: await trades.listOffers(req.userId, req.query.fulfillable === "1"), mine: await trades.myOffers(req.userId) });
}));
app.post("/trades/create", authMiddleware, wrap(async (req, res) => {
  const out = await trades.createOffer(req.userId, req.body && req.body.offerInst, req.body && req.body.wantTpl);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
app.post("/trades/cancel", authMiddleware, wrap(async (req, res) => {
  const out = await trades.cancelOffer(req.userId, req.body && req.body.id);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));
app.post("/trades/accept", authMiddleware, wrap(async (req, res) => {
  const out = await trades.acceptOffer(req.userId, req.body && req.body.id, req.body && req.body.payInst);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));

// ----------------------------------- LOGROS ----------------------------------
app.get("/achievements", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  res.json(await achievements.list(req.userId, u));
}));
app.post("/achievements/claim", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  const out = await achievements.claim(req.userId, u, req.body && req.body.key);
  if (out.error) return res.status(400).json(out);
  res.json(out);
}));

// ------------------------- MARCOS COSMÉTICOS (frames) ------------------------
// Se desbloquean por progreso (mejor liga alcanzada / victorias): cosmética
// pura, cero ventaja de combate (regla de monetización no tóxica).
const FRAMES = {
  plata:    { name: "Marco Plata",    req: (u) => leagueOrd(u.best_league) >= 1 },
  oro:      { name: "Marco Oro",      req: (u) => leagueOrd(u.best_league) >= 2 },
  diamante: { name: "Marco Diamante", req: (u) => leagueOrd(u.best_league) >= 4 },
  campeon:  { name: "Marco Campeón",  req: (u) => u.total_wins >= 100 },
};
const leagueOrd = (l) => ({ BRONCE: 0, PLATA: 1, ORO: 2, PLATINO: 3, DIAMANTE: 4 }[l] || 0);
app.get("/frames", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  res.json(Object.entries(FRAMES).map(([key, f]) => ({ key, name: f.name, unlocked: f.req(u) })));
}));
app.put("/creature/:id/frame", authMiddleware, wrap(async (req, res) => {
  const frame = (req.body && req.body.frame) || null;
  if (frame) {
    const def = FRAMES[frame];
    const u = await getUser(req.userId);
    if (!def || !def.req(u)) return res.status(400).json({ error: "frame_locked" });
  }
  const r = await db.query(
    "UPDATE creature_instances SET cosmetic_frame=$1 WHERE instance_id=$2 AND user_id=$3 RETURNING cosmetic_frame",
    [frame, req.params.id, req.userId]
  );
  if (!r.rowCount) return res.status(404).json({ error: "not_found" });
  res.json({ frame: r.rows[0].cosmetic_frame });
}));

// ---------------------------------- WEB PUSH ---------------------------------
app.get("/push/key", (req, res) => res.json({ enabled: push.enabled(), key: push.publicKey() }));
app.post("/push/subscribe", authMiddleware, wrap(async (req, res) => {
  if (!push.enabled()) return res.status(501).json({ error: "push_disabled" });
  const sub = req.body && req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: "bad_subscription" });
  await db.query(
    `INSERT INTO push_subs (user_id, endpoint, sub) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, endpoint) DO UPDATE SET sub=$3`,
    [req.userId, sub.endpoint, JSON.stringify(sub)]
  );
  res.json({ ok: true });
}));
app.post("/push/unsubscribe", authMiddleware, wrap(async (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  await db.query("DELETE FROM push_subs WHERE user_id=$1 AND ($2::text IS NULL OR endpoint=$2)", [req.userId, endpoint || null]);
  res.json({ ok: true });
}));

// ------------------------- OBSERVABILIDAD MÍNIMA -----------------------------
// Errores del CLIENTE: beacon ligero al log del servidor (sin Sentry todavía,
// pero deja de ser un agujero negro). Rate limit estricto y campos acotados.
const errorLimiter = rateLimit({ windowMs: 60 * 1000, max: 5, standardHeaders: false, legacyHeaders: false });
app.post("/client-errors", errorLimiter, (req, res) => {
  const b = req.body || {};
  const msg = String(b.msg || "").slice(0, 300);
  const src = String(b.src || "").slice(0, 200);
  const ua = String(req.headers["user-agent"] || "").slice(0, 120);
  if (msg) console.error(`[cliente] ${msg} @ ${src} · ${ua}`);
  res.json({ ok: true });
});

// Stats de negocio (DAU, retención D1/D7, combates): protegido por ADMIN_KEY.
//   curl -H "x-admin-key: $ADMIN_KEY" /admin/stats
app.get("/admin/stats", wrap(async (req, res) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.headers["x-admin-key"] !== key) return res.status(404).json({ error: "not_found" });
  const today = C.todayStr();
  const q = async (sql, params) => (await db.query(sql, params)).rows[0];
  const users = await q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE created_at::date = CURRENT_DATE)::int AS new_today FROM users");
  const dau = await q("SELECT COUNT(*)::int AS n FROM users WHERE last_claim_date = $1", [today]);
  const battles = await q("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE defender_id IS NOT NULL)::int AS pvp FROM battles WHERE daily_date = $1", [today]);
  // Retención: de los creados hace N días, ¿cuántos reclamaron HOY?
  const ret = async (days) => {
    const r = await q(
      `SELECT COUNT(*)::int AS cohort, COUNT(*) FILTER (WHERE last_claim_date = $1)::int AS back
         FROM users WHERE created_at::date = CURRENT_DATE - $2::int`, [today, days]);
    return { cohort: r.cohort, back: r.back, rate: r.cohort ? Math.round(r.back / r.cohort * 100) : null };
  };
  res.json({
    date: today,
    users: { total: users.total, newToday: users.new_today, dauToday: dau.n },
    battlesToday: { total: battles.total, pvp: battles.pvp },
    retention: { d1: await ret(1), d7: await ret(7) },
  });
}));

// ===================== MECÁNICAS INNOVADORAS (endpoints) =====================
// -- PUZZLE DIARIO: combate-reto idéntico para todos, mín. turnos --------------
app.get("/puzzle", authMiddleware, requireFeature("puzzle"), wrap(async (req, res) => {
  const tpls = await todayTemplates();
  const pz = C.dailyPuzzle(C.todayStr(), tpls);
  const byId = {}; tpls.forEach((t) => (byId[t.id] = t));
  const pubUnit = (id, team, i) => publicUnit(combat.buildUnit(byId[id], pz.level, team, i));
  const best = (await db.query("SELECT turns, hp_left, solved FROM puzzle_results WHERE daily_date=$1 AND user_id=$2", [C.todayStr(), req.userId])).rows[0] || null;
  res.json({ date: pz.date, seed: pz.seed, level: pz.level,
    team: pz.team.map((id, i) => pubUnit(id, "A", i)),
    enemy: pz.enemy.map((id, i) => pubUnit(id, "B", i)),
    best, ranking: await innov.puzzleRanking(req.userId) });
}));
app.post("/puzzle/solve", authMiddleware, requireFeature("puzzle"), wrap(async (req, res) => {
  const tpls = await todayTemplates();
  const out = await innov.solvePuzzle(req.userId, (req.body && req.body.decisions) || [], tpls);
  res.json(Object.assign(out, { ranking: await innov.puzzleRanking(req.userId) }));
}));

// -- JEFE MUNDIAL: raid cooperativa, HP global compartido ----------------------
// El GET incluye el ENCUENTRO (tu equipo + avatares del jefe + seed determinista
// por nº de golpe): el cliente anima EXACTAMENTE lo que el POST validará.
app.get("/worldboss", authMiddleware, requireFeature("worldboss"), wrap(async (req, res) => {
  const state = await innov.bossState(req.userId);
  if (!state.defeated) {
    const tpls = await todayTemplates();
    const enc = await innov.bossEncounter(req.userId, tpls);
    state.encounter = { seed: enc.seed, team: enc.A.map(publicUnit), enemy: enc.B.map(publicUnit) };
  }
  res.json(state);
}));
app.post("/worldboss/hit", authMiddleware, requireFeature("worldboss"), wrap(async (req, res) => {
  let u = await getUser(req.userId); u = await syncEnergy(u);
  if (u.energy < 1) return res.status(402).json({ error: "no_energy" });
  // El golpe al jefe cuesta 1⚡ (como un combate normal).
  await db.query("UPDATE users SET energy = GREATEST(energy-1,0), energy_updated_at = CASE WHEN energy-1 < $2 THEN now() ELSE energy_updated_at END WHERE id=$1", [req.userId, C.ENERGY_MAX]);
  const tpls = await todayTemplates();
  const out = await innov.hitBoss(req.userId, (req.body && req.body.decisions) || [], tpls);
  res.json(out);
}));

// -- NÉMESIS: rival IA recurrente con counter-pick e historia ------------------
// GET devuelve TAMBIÉN tu equipo y el seed determinista del encuentro: el
// cliente anima exactamente el combate que el POST validará (mismo seed/equipos).
app.get("/nemesis", authMiddleware, requireFeature("nemesis"), wrap(async (req, res) => {
  const tpls = await todayTemplates();
  const enc = await innov.nemesisEncounter(req.userId, tpls);
  const A = await buildTeamUnits(req.userId);
  res.json({ name: enc.name, tier: enc.tier, winsVsMe: enc.winsVsMe, myWins: enc.myWins, level: enc.level,
    seed: enc.seed, team: A.map(publicUnit), enemy: enc.enemy.map(publicUnit) });
}));
app.post("/nemesis/fight", authMiddleware, requireFeature("nemesis"), wrap(async (req, res) => {
  let u = await getUser(req.userId); u = await syncEnergy(u);
  if (u.energy < 1) return res.status(402).json({ error: "no_energy" });
  const A = await buildTeamUnits(req.userId);
  if (!A.length) return res.status(400).json({ error: "empty_team" });
  const tpls = await todayTemplates();
  const enc = await innov.nemesisEncounter(req.userId, tpls); // mismo encuentro que el GET
  const safe = innov.sanitizeDecisions((req.body && req.body.decisions) || []);
  const B = enc.enemy.map((e, i) => combat.unitFromStats(publicUnit(e), "B", i));
  const result = combat.resolveBattle(A, B, enc.seed, safe);
  const win = result.winner === "A";
  const nem = await innov.nemesisResult(req.userId, win);
  const award = await awardBattleResult({ user: u, win, abilitiesUsed: 0, seed: enc.seed });
  // Derrotar a la némesis concede su marco único una vez.
  if (win) await db.query("INSERT INTO achievements (user_id, key) VALUES ($1,'nemesis_slayer') ON CONFLICT DO NOTHING", [req.userId]);
  res.json({ win, nemesis: nem, coins: award.coins, leaguePoints: award.leaguePoints, league: award.league, energy: award.energy });
}));

// -- ORÁCULO: profecía determinista del DESTACADO de MAÑANA --------------------
app.get("/oracle", authMiddleware, requireFeature("oracle"), wrap(async (req, res) => {
  // Profecía del destacado de MAÑANA (rotación determinista sobre el álbum del
  // mes). Como el destacado se deriva de la fecha, la pista cuadra con lo que
  // de verdad saldrá mañana.
  const tomorrow = C.todayStr(new Date(Date.now() + 86400000));
  const tpls = await dailyTemplates(tomorrow);
  res.json(C.oracleProphecy(tomorrow, tpls));
}));

// -- ARENA SELLADA: draft del lote, PvP sin colección (cola con flag) ----------
// El emparejamiento/draft viven en el WebSocket /pvp (modo arena); este endpoint
// solo entrega los 6 candidatos del draft del día (deterministas, compartidos).
app.get("/arena/draft", authMiddleware, requireFeature("arena"), wrap(async (req, res) => {
  const tpls = await todayTemplates();
  const seed = C.hashStr("arena:" + C.todayStr()) >>> 0;
  const rng = C.mulberry32(seed);
  const pool = []; const used = {};
  while (pool.length < 6 && pool.length < tpls.length) {
    const i = Math.floor(rng() * tpls.length);
    if (!used[i]) { used[i] = 1; pool.push(tpls[i]); }
  }
  res.json({ date: C.todayStr(), candidates: pool.map((t) => ({ id: t.id, name: t.name, type: t.type, types: t.types, rarity: t.rarity, ability: t.ability, art_seed: t.art_seed, image_url: t.image_url, base_stats: t.base_stats })) });
}));

// Tareas de ARTE ejecutables en remoto (Railway no tiene shell cómoda): se
// lanzan en background y el estado se consulta. Mismo ADMIN_KEY que /admin/stats.
//   POST /admin/tasks/remove-art-backgrounds[?dryRun=1&tolerance=42]
//   POST /admin/tasks/gen-ui-assets[?variants=3&only=icon,arena]
//   POST /admin/tasks/boss-art            (arte del jefe de esta semana)
//   POST /admin/tasks/season-art[?month=YYYY-MM]  (arte del álbum del mes)
//   POST /admin/tasks/unique-art[?date=YYYY-MM-DD] (arte de la criatura única)
//   GET  /admin/tasks                     (estado de todas)
const artTasks = require("./artTasks");
const _adminTasks = {}; // name -> { status, startedAt, finishedAt, result|error }
const requireAdmin = (req, res, next) => {
  const key = process.env.ADMIN_KEY;
  if (!key || req.headers["x-admin-key"] !== key) return res.status(404).json({ error: "not_found" });
  next();
};
const ADMIN_TASKS = {
  "remove-art-backgrounds": (q) => artTasks.removeArtBackgrounds({ dryRun: q.dryRun === "1", tolerance: q.tolerance }),
  "gen-ui-assets": (q) => artTasks.generateUiAssets({ variants: q.variants, only: (q.only || "").split(",").filter(Boolean) }),
  "boss-art": () => require("./innovations").ensureBossArt().then((ok) => ({ generated: ok })),
  // Rellena el arte IA del ÁLBUM del mes indicado (?month=YYYY-MM, def: actual).
  "season-art": (q) => generateSeason(C.seasonKey((q.month ? q.month + "-01" : C.todayStr())), SEASON_N, { withArt: true }),
  // Genera el arte de la criatura ÚNICA del día (?date=YYYY-MM-DD, def: hoy).
  "unique-art": (q) => generateDailyUnique(q.date || C.todayStr(), { withArt: true }),
  // Arte de VARIANTES: ?scope=season pregenera TODO el álbum (evoluciones según
  // plan + áureas, destacados primero, hasta ?limit imágenes); por defecto,
  // backfill de las variantes ya en manos de jugadores sin imagen.
  "variant-art": (q) => q.scope === "season"
    ? variantArt.pregenerateSeasonVariants(C.seasonKey(C.todayStr()), { limit: q.limit })
    : variantArt.backfillVariantArt(),
  // Rebalanceo de stats de plantillas guardadas (motor con presupuesto por rareza).
  "rebalance-stats": () => rebalanceTemplates(),
  // Volumen de arte: informe de uso y limpieza (los .bak de remove-art-backgrounds
  // duplican el espacio; ?orphans=1 borra además arte sin fila en BD).
  "art-usage": () => artTasks.artUsage(),
  "art-cleanup": (q) => artTasks.artCleanup({ orphans: q.orphans === "1" }),
  // Migra el arte del volumen al almacén externo S3 (R2/B2/GCS) configurado por
  // ART_S3_*; ?delete=1 borra los locales tras subirlos (libera el volumen).
  "art-migrate": (q) => artTasks.migrateArtToStorage({ delete: q.delete === "1" }),
  // Autodiagnóstico del almacén externo: sube/lee un objeto de prueba y verifica
  // la URL pública. Lánzala ANTES de art-migrate para validar las variables.
  "art-storage-test": () => require("./ai/storage").selfTest(),
};
app.post("/admin/tasks/:task", requireAdmin, (req, res) => {
  const name = req.params.task;
  const fn = ADMIN_TASKS[name];
  if (!fn) return res.status(400).json({ error: "bad_task", tasks: Object.keys(ADMIN_TASKS) });
  if (_adminTasks[name] && _adminTasks[name].status === "running") {
    return res.status(409).json({ error: "already_running", task: _adminTasks[name] });
  }
  const entry = (_adminTasks[name] = { status: "running", startedAt: new Date().toISOString() });
  fn(req.query || {})
    .then((result) => {
      entry.status = "done"; entry.result = result; entry.finishedAt = new Date().toISOString();
      // Las tareas de arte cambian image_url: invalida la caché de la landing
      // para que el resultado se vea al instante (antes tardaba hasta 5 min).
      _landingCache = { key: null, at: 0, data: null };
    })
    .catch((e) => { entry.status = "error"; entry.error = e.message; entry.finishedAt = new Date().toISOString(); });
  res.json({ started: name, poll: "GET /admin/tasks" });
});
app.get("/admin/tasks", requireAdmin, (req, res) => res.json(_adminTasks));

// --------------------------------- HEALTH ------------------------------------
app.get("/health", wrap(async (req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true, date: C.todayStr() });
}));

// --------------------------- manejo de errores -------------------------------
app.use((req, res) => res.status(404).json({ error: "not_found" }));
// Aridad 4 obligatoria: así detecta Express que es el manejador de errores.
app.use((err, req, res, next) => {
  // Stack completo + ruta en el log (depurable); al cliente solo un id opaco
  // para correlacionar reportes con el log sin filtrar detalles internos.
  const errorId = Math.random().toString(36).slice(2, 10);
  console.error(`[error ${errorId}] ${req.method} ${req.originalUrl}\n${err.stack || err.message}`);
  res.status(500).json({ error: "server_error", errorId });
});

// --------------------------------- arranque ----------------------------------
const PORT = process.env.PORT || 3000;
let server;
if (require.main === module) {
  // Escuchar en 0.0.0.0 (requisito de Railway/PaaS para que el proxy llegue a la app).
  server = app.listen(PORT, "0.0.0.0", () => console.log(`AIGRONS API escuchando en 0.0.0.0:${PORT} (frontend en /)`));
  // Cron HORARIO (catch-up continuo, todo idempotente — cada pasada solo genera
  // lo que FALTA): mientras haya déficit de imágenes, cada hora drena más.
  //   1. Arte del álbum del MES ACTUAL.
  //   2. Álbum del MES SIGUIENTE desde 7 días antes del cambio (que el día 1
  //      amanezca completo, no a medias).
  //   3. Única de HOY y de MAÑANA con sus variantes (nunca sale sin imagen).
  //   4. Pregen de variantes del álbum (cap por pasada: reparte la cuota).
  startCron(async () => {
    const today = C.todayStr();
    const tomorrow = C.todayStr(new Date(Date.now() + 86400000));
    await generateSeason(C.seasonKey(today), SEASON_N, { withArt: true });
    const d0 = new Date(today + "T00:00:00");
    const firstNext = new Date(d0.getFullYear(), d0.getMonth() + 1, 1);
    const daysToNext = Math.ceil((firstNext - d0) / 86400000);
    if (daysToNext <= 7) await generateSeason(C.seasonKey(C.todayStr(firstNext)), SEASON_N, { withArt: true });
    for (const day of [today, tomorrow]) {
      await generateDailyUnique(day, { withArt: true });
      const uniq = await tplById(C.dailyUniqueId(day));
      if (uniq) await variantArt.pregenerateTemplateVariants(uniq);
    }
    await variantArt.pregenerateSeasonVariants(C.seasonKey(today), {});
  });
  startMaintenance(db); // limpieza de tablas + cierre semanal de ligas
  // REBALANCEO one-shot al arrancar (marca en app_meta + advisory lock): alinea
  // las stats de las plantillas YA guardadas con el motor normalizado por
  // presupuesto. Sin esto, la temporada en curso conservaría el desbalance viejo.
  (async () => {
    const KEY = "rebalance_budget_v1";
    const done = await db.query("SELECT 1 FROM app_meta WHERE key=$1", [KEY]);
    if (done.rowCount) return;
    const client = await db.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext($1))", [KEY]);
      const again = await db.query("SELECT 1 FROM app_meta WHERE key=$1", [KEY]);
      if (!again.rowCount) {
        await rebalanceTemplates();
        await db.query("INSERT INTO app_meta (key, value) VALUES ($1, now()::text) ON CONFLICT DO NOTHING", [KEY]);
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [KEY]).catch(() => {});
      client.release();
    }
  })().catch((e) => console.warn("[rebalance]", e.message));
  push.initPush(db).then(() => push.startPushCron(db)).catch((e) => console.warn("[push]", e.message));

  // PvP en vivo (WebSocket en /pvp, mismo puerto). Inyecta los helpers compartidos.
  try {
    const { attachPvp } = require("./pvp");
    attachPvp(server, { db, getUser, syncEnergy, buildTeamUnits, buildArenaUnits, awardBattleResult, publicUnit, MATCH_LEVEL_WINDOW, todayTemplates });
    console.log("PvP en vivo (WebSocket) activo en /pvp");
  } catch (e) {
    console.warn("[pvp] no se pudo activar el WebSocket:", e.message);
  }

  // Apagado ordenado: deja de aceptar, cierra el pool.
  const shutdown = (sig) => {
    console.log(`\n${sig} recibido, cerrando...`);
    if (server) server.close(() => {
      db.pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

module.exports = app;
