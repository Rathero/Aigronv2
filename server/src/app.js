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
const { generateDailyBatch } = require("./jobs/generateDailyBatch");
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

const DAILY_N = parseInt(process.env.DAILY_BATCH_SIZE || "30", 10);

// --------------------------------- helpers ----------------------------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Orden de ligas como expresión SQL (para comparar best_league).
const leagueOrdSql = (col) =>
  `CASE ${col} WHEN 'DIAMANTE' THEN 4 WHEN 'PLATINO' THEN 3 WHEN 'ORO' THEN 2 WHEN 'PLATA' THEN 1 ELSE 0 END`;

function yesterdayStr() {
  return C.todayStr(new Date(Date.now() - 86400000));
}
async function ensureDailyBatch(date) {
  const r = await db.query("SELECT 1 FROM creature_templates WHERE batch_date=$1 AND is_fusion=false LIMIT 1", [date]);
  if (r.rowCount > 0) return;
  // Advisory lock: a medianoche TODOS los clientes piden /daily a la vez
  // (thundering herd); sin el lock varios procesos generarían el lote en paralelo.
  const client = await db.pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", ["gen:" + date]);
    const again = await db.query("SELECT 1 FROM creature_templates WHERE batch_date=$1 AND is_fusion=false LIMIT 1", [date]);
    if (again.rowCount === 0) await generateDailyBatch(date, DAILY_N);
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", ["gen:" + date]).catch(() => {});
    client.release();
  }
}
async function todayTemplates() {
  const date = C.todayStr();
  await ensureDailyBatch(date);
  const r = await db.query(
    "SELECT template_id,name,type,type2,rarity,ability_id,base_hp,base_atk,base_def,base_spd,base_atk_p,base_atk_s,base_def_p,base_def_s,art_seed,lore,image_url,image_thumb_url FROM creature_templates WHERE batch_date=$1 AND is_fusion=false ORDER BY template_id",
    [date]
  );
  return r.rows.map((x) => ({
    id: x.template_id, name: x.name, type: x.type, types: tplTypes(x), rarity: x.rarity, ability: x.ability_id,
    art_seed: x.art_seed, lore: x.lore, image_url: x.image_url, image_thumb_url: x.image_thumb_url,
    base_stats: tplBaseStats(x),
  }));
}
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
    // Tiradas de tienda de HOY (techo diario): el cliente muestra cuántas quedan.
    rollsToday: u.rolls_date && C.todayStr(new Date(u.rolls_date)) === C.todayStr() ? u.rolls_today : 0,
    rollsMax: 10,
    claimedToday: !!(u.last_claim_date && C.todayStr(new Date(u.last_claim_date)) === C.todayStr()),
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
    `SELECT ci.instance_id, ci.level, t.template_id, t.name, t.type, t.type2, t.ability_id,
            t.base_hp, t.base_atk, t.base_def, t.base_spd, t.base_atk_p, t.base_atk_s, t.base_def_p, t.base_def_s,
            t.image_url, t.image_thumb_url
       FROM creature_instances ci JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.instance_id = ANY($1::uuid[])`,
    [slots]
  );
  const byId = {}; inst.rows.forEach((r) => (byId[r.instance_id] = r));
  return slots.map((iid, i) => {
    const r = byId[iid]; if (!r) return null;
    const tplLike = { id: r.template_id, name: r.name, type: r.type, types: tplTypes(r), ability: r.ability_id, base_stats: tplBaseStats(r) };
    const u = combat.buildUnit(tplLike, r.level, team, i);
    u.instanceId = iid; // para mapear el capitán elegido a su uid de combate
    // Arte IA: el RIVAL puede no tener esta plantilla en su caché (lote de otro
    // día, fusión); viaja con la unidad para que la vea con su imagen real.
    u.imageUrl = r.image_url; u.imageThumbUrl = r.image_thumb_url;
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

  // Si es nuevo y no tiene aigrons, le damos 3 starters del lote de hoy.
  const has = await db.query("SELECT 1 FROM creature_instances WHERE user_id=$1 LIMIT 1", [user.id]);
  if (has.rowCount === 0) {
    const tpls = await todayTemplates();
    for (const t of tpls.slice(0, 3)) {
      await db.query(
        "INSERT INTO creature_instances (user_id, template_id, level, locked) VALUES ($1,$2,3,true)",
        [user.id, t.id]
      );
    }
  }
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
app.get("/daily", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  const list = await todayTemplates();
  res.json({ date: C.todayStr(), count: list.length, claimed: userPublic(u).claimedToday, nextBatchAt: nextBatchAt(), event: eventFor(C.todayStr()), batch: list });
}));

app.post("/daily/claim", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  const list = await todayTemplates(); // antes de marcar el reclamo: si falla, no se pierde la tirada
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
  const t = list[Math.floor(Math.random() * list.length)];
  let ins;
  try {
    ins = await db.query(
      "INSERT INTO creature_instances (user_id, template_id) VALUES ($1,$2) RETURNING instance_id, level",
      [u.id, t.id]
    );
  } catch (e) {
    // Devuelve el reclamo si la criatura no llegó a crearse (el usuario podrá reintentar).
    await db.query("UPDATE users SET last_claim_date=$1, daily_streak=$2, coins=coins-30 WHERE id=$3",
      [u.last_claim_date, u.daily_streak, u.id]).catch(() => {});
    throw e;
  }
  await bumpMission(u.id, "claims", 1);
  res.json({ instance: { instance_id: ins.rows[0].instance_id, level: ins.rows[0].level, template: t }, streak });
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
    `SELECT ci.instance_id, ci.level, ci.xp, ci.favorite, ci.locked, ci.obtained_at, ci.cosmetic_frame,
            t.template_id, t.name, t.type, t.type2, t.rarity, t.ability_id, t.lore, t.art_seed,
            t.base_hp, t.base_atk, t.base_def, t.base_spd, t.base_atk_p, t.base_atk_s, t.base_def_p, t.base_def_s,
            t.image_url, t.image_thumb_url
       FROM creature_instances ci JOIN creature_templates t ON t.template_id=ci.template_id
      WHERE ci.user_id=$1 ORDER BY ci.obtained_at DESC`,
    [req.userId]
  );
  res.json(r.rows.map((x) => {
    const b = tplBaseStats(x);
    return {
      instance_id: x.instance_id, level: x.level, favorite: x.favorite, locked: x.locked,
      obtained_at: x.obtained_at, // para el badge NUEVO (obtenido hoy) del cliente
      frame: x.cosmetic_frame,
      template: {
        id: x.template_id, name: x.name, type: x.type, types: tplTypes(x), rarity: x.rarity, ability: x.ability_id,
        lore: x.lore, art_seed: x.art_seed, image_url: x.image_url, image_thumb_url: x.image_thumb_url,
        base_stats: b,
        stats: { hp: C.scaled(b.hp, x.level), atkP: C.scaled(b.atkP, x.level), atkS: C.scaled(b.atkS, x.level),
                 defP: C.scaled(b.defP, x.level), defS: C.scaled(b.defS, x.level), spd: C.scaled(b.spd, x.level) },
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
  res.json({ level: up.rows[0].level, cost });
}));

app.post("/creature/:id/release", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT ci.*, t.rarity FROM creature_instances ci JOIN creature_templates t ON t.template_id=ci.template_id WHERE ci.instance_id=$1 AND ci.user_id=$2", [req.params.id, req.userId]);
  const inst = r.rows[0];
  if (!inst) return res.status(404).json({ error: "not_found" });
  if (inst.locked) return res.status(400).json({ error: "locked" });
  const team = await db.query("SELECT 1 FROM teams WHERE user_id=$1 AND (slot1=$2 OR slot2=$2 OR slot3=$2)", [req.userId, inst.instance_id]);
  if (team.rowCount) return res.status(400).json({ error: "in_team" });
  const dust = C.RELEASE_DUST[inst.rarity] || 5;
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

// ----------------------------------- TEAM ------------------------------------
app.get("/team", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT slot1,slot2,slot3 FROM teams WHERE user_id=$1", [req.userId]);
  res.json(r.rows[0] || { slot1: null, slot2: null, slot3: null });
}));

app.put("/team", authMiddleware, wrap(async (req, res) => {
  const slots = (req.body && req.body.slots) || [];
  if (!Array.isArray(slots)) return res.status(400).json({ error: "bad_slots" });
  const own = await db.query("SELECT instance_id, level, template_id FROM creature_instances WHERE user_id=$1 AND instance_id = ANY($2::uuid[])", [req.userId, slots]);
  const valid = own.rows.map((x) => x.instance_id);
  const ordered = slots.filter((s) => valid.includes(s)).slice(0, 3);
  const snapshot = own.rows
    .filter((x) => ordered.includes(x.instance_id))
    .map((x) => ({ template_id: x.template_id, level: x.level }));
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
    const tplLike = { id: t.template_id, name: t.name, type: t.type, types: tplTypes(t), ability: t.ability_id, base_stats: tplBaseStats(t) };
    const u = combat.buildUnit(tplLike, s.level, "B", out.length);
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
  const list = await todayTemplates();
  const t = list[Math.floor(Math.random() * list.length)];
  let ins;
  try {
    ins = await db.query("INSERT INTO creature_instances (user_id, template_id) VALUES ($1,$2) RETURNING instance_id", [u.id, t.id]);
  } catch (e) {
    // Reembolsa si la criatura no llegó a crearse.
    await db.query("UPDATE users SET coins=coins+100, rolls_today=GREATEST(rolls_today-1,0) WHERE id=$1", [u.id]).catch(() => {});
    throw e;
  }
  res.json({ instance_id: ins.rows[0].instance_id, template: t });
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
app.get("/worldboss", authMiddleware, requireFeature("worldboss"), wrap(async (req, res) => {
  res.json(await innov.bossState(req.userId));
}));
app.post("/worldboss/hit", authMiddleware, requireFeature("worldboss"), wrap(async (req, res) => {
  let u = await getUser(req.userId); u = await syncEnergy(u);
  if (u.energy < 1) return res.status(402).json({ error: "no_energy" });
  // El golpe al jefe cuesta 1⚡ (como un combate normal).
  await db.query("UPDATE users SET energy = GREATEST(energy-1,0), energy_updated_at = CASE WHEN energy-1 < $2 THEN now() ELSE energy_updated_at END WHERE id=$1", [req.userId, C.ENERGY_MAX]);
  const tpls = await todayTemplates();
  const out = await innov.hitBoss(req.userId, (req.body && req.body.decisions) || [], tpls, u);
  res.json(out);
}));

// -- NÉMESIS: rival IA recurrente con counter-pick e historia ------------------
app.get("/nemesis", authMiddleware, requireFeature("nemesis"), wrap(async (req, res) => {
  const tpls = await todayTemplates();
  const enc = await innov.nemesisEncounter(req.userId, tpls);
  res.json({ name: enc.name, tier: enc.tier, winsVsMe: enc.winsVsMe, myWins: enc.myWins, level: enc.level,
    enemy: enc.enemy.map(publicUnit) });
}));
app.post("/nemesis/fight", authMiddleware, requireFeature("nemesis"), wrap(async (req, res) => {
  let u = await getUser(req.userId); u = await syncEnergy(u);
  if (u.energy < 1) return res.status(402).json({ error: "no_energy" });
  const A = await buildTeamUnits(req.userId);
  if (!A.length) return res.status(400).json({ error: "empty_team" });
  const tpls = await todayTemplates();
  const enc = await innov.nemesisEncounter(req.userId, tpls);
  const seed = (C.hashStr("nemfight:" + req.userId + ":" + Date.now()) >>> 0);
  const safe = innov.sanitizeDecisions((req.body && req.body.decisions) || []);
  const B = enc.enemy.map((e, i) => combat.unitFromStats(publicUnit(e), "B", i));
  const result = combat.resolveBattle(A, B, seed, safe);
  const win = result.winner === "A";
  const nem = await innov.nemesisResult(req.userId, win);
  const award = await awardBattleResult({ user: u, win, abilitiesUsed: 0, seed });
  // Derrotar a la némesis concede su marco único una vez.
  if (win) await db.query("INSERT INTO achievements (user_id, key) VALUES ($1,'nemesis_slayer') ON CONFLICT DO NOTHING", [req.userId]);
  res.json({ win, nemesis: nem, coins: award.coins, leaguePoints: award.leaguePoints, league: award.league, energy: award.energy,
    log: result.log, seed, team: A.map(publicUnit), enemy: B.map(publicUnit) });
}));

// -- ORÁCULO: profecía determinista del lote de MAÑANA -------------------------
app.get("/oracle", authMiddleware, requireFeature("oracle"), wrap(async (req, res) => {
  // Profecía de MAÑANA: si el lote de mañana aún no existe, se deriva igual
  // (determinista por fecha) generándolo en memoria sin persistir.
  const tomorrow = C.todayStr(new Date(Date.now() + 86400000));
  let tpls = (await db.query("SELECT type, type2, rarity FROM creature_templates WHERE batch_date=$1 AND is_fusion=false", [tomorrow])).rows
    .map((x) => ({ type: x.type, types: x.type2 ? [x.type, x.type2] : [x.type], rarity: x.rarity }));
  if (!tpls.length) tpls = C.dailyBatch(tomorrow, DAILY_N);
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
  startCron(generateDailyBatch, DAILY_N);
  startMaintenance(db); // limpieza de tablas + cierre semanal de ligas
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
