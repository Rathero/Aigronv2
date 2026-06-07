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
const { sign, authMiddleware, verifyIdentity } = require("./auth");
const { generateDailyBatch } = require("./jobs/generateDailyBatch");
const { startCron } = require("./cron");
const { fuse } = require("./fusion");
const dungeon = require("./dungeon");
const { tplBaseStats, tplTypes } = require("./util");

const app = express();
app.set("trust proxy", 1); // detrás de proxy/CDN: IP real para rate limiting

// --- Seguridad de cabeceras. CSP permite el frontend inline + Google Fonts. ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

const CORS_ORIGIN = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*";
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json({ limit: "256kb" }));

// Rate limiting: general + login estricto (anti fuerza bruta).
const generalLimiter = rateLimit({ windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use("/auth/", loginLimiter);
app.use(generalLimiter);

// Sirve el frontend en / para probar en local (http://localhost:3000)
app.use(express.static(path.join(__dirname, "../../web")));

const DAILY_N = parseInt(process.env.DAILY_BATCH_SIZE || "30", 10);

// --------------------------------- helpers ----------------------------------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function yesterdayStr() {
  return C.todayStr(new Date(Date.now() - 86400000));
}
async function ensureDailyBatch(date) {
  const r = await db.query("SELECT 1 FROM creature_templates WHERE batch_date=$1 AND is_fusion=false LIMIT 1", [date]);
  if (r.rowCount === 0) await generateDailyBatch(date, DAILY_N);
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
    league: u.league, leaguePoints: u.league_points,
    streak: u.daily_streak,
    claimedToday: !!(u.last_claim_date && C.todayStr(new Date(u.last_claim_date)) === C.todayStr()),
  };
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
async function buildTeamUnits(userId) {
  const t = await db.query("SELECT slot1,slot2,slot3 FROM teams WHERE user_id=$1", [userId]);
  let slots = t.rows[0] ? [t.rows[0].slot1, t.rows[0].slot2, t.rows[0].slot3].filter(Boolean) : [];
  if (!slots.length) {
    const r = await db.query("SELECT instance_id FROM creature_instances WHERE user_id=$1 ORDER BY obtained_at LIMIT 3", [userId]);
    slots = r.rows.map((x) => x.instance_id);
  }
  if (!slots.length) return [];
  const inst = await db.query(
    `SELECT ci.instance_id, ci.level, t.template_id, t.name, t.type, t.type2, t.ability_id,
            t.base_hp, t.base_atk, t.base_def, t.base_spd, t.base_atk_p, t.base_atk_s, t.base_def_p, t.base_def_s
       FROM creature_instances ci JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.instance_id = ANY($1::uuid[])`,
    [slots]
  );
  const byId = {}; inst.rows.forEach((r) => (byId[r.instance_id] = r));
  return slots.map((iid, i) => {
    const r = byId[iid]; if (!r) return null;
    const tplLike = { id: r.template_id, name: r.name, type: r.type, types: tplTypes(r), ability: r.ability_id, base_stats: tplBaseStats(r) };
    const u = combat.buildUnit(tplLike, r.level, "A", i);
    u.instanceId = iid; // para mapear el capitán elegido a su uid de combate
    return u;
  }).filter(Boolean);
}
const teamAvgLevel = (units) => units.length ? Math.round(units.reduce((a, u) => a + (u.level || 1), 0) / units.length) : 3;
function publicUnit(u) {
  return { uid: u.uid, tplId: u.tplId, name: u.name, type: u.type, types: u.types, ability: u.ability, level: u.level,
    hpMax: u.hpMax, atkP: u.atkP, atkS: u.atkS, defP: u.defP, defS: u.defS, spd: u.spd, startEnergy: u.startEnergy || 0 };
}

// ---------------------------------- AUTH -------------------------------------
app.post("/auth/login", wrap(async (req, res) => {
  const { provider = "dev", subject, idToken, displayName } = req.body || {};
  let identity;
  try {
    identity = await verifyIdentity({ provider, subject, idToken, displayName });
  } catch (e) {
    return res.status(401).json({ error: "auth_failed", detail: e.message });
  }
  const up = await db.query(
    `INSERT INTO users (display_name, auth_provider, auth_subject)
     VALUES ($1,$2,$3)
     ON CONFLICT (auth_subject) DO UPDATE SET display_name = EXCLUDED.display_name
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
  res.json(pub);
}));

// ---------------------------------- DAILY ------------------------------------
app.get("/daily", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  const list = await todayTemplates();
  res.json({ date: C.todayStr(), count: list.length, claimed: userPublic(u).claimedToday, batch: list });
}));

app.post("/daily/claim", authMiddleware, wrap(async (req, res) => {
  const u = await getUser(req.userId);
  if (userPublic(u).claimedToday) return res.status(400).json({ error: "already_claimed" });
  const list = await todayTemplates();
  const t = list[Math.floor(Math.random() * list.length)];
  const ins = await db.query(
    "INSERT INTO creature_instances (user_id, template_id) VALUES ($1,$2) RETURNING instance_id, level",
    [u.id, t.id]
  );
  const streak = u.last_claim_date && C.todayStr(new Date(u.last_claim_date)) === yesterdayStr() ? u.daily_streak + 1 : 1;
  await db.query("UPDATE users SET last_claim_date=$1, daily_streak=$2, coins=coins+30 WHERE id=$3",
    [C.todayStr(), streak, u.id]);
  await bumpMission(u.id, "claims", 1);
  res.json({ instance: { instance_id: ins.rows[0].instance_id, level: ins.rows[0].level, template: t }, streak });
}));

// -------------------------------- MISSIONS -----------------------------------
app.get("/missions", authMiddleware, wrap(async (req, res) => {
  res.json(await missionsPublic(req.userId));
}));
app.post("/missions/claim", authMiddleware, wrap(async (req, res) => {
  const key = req.body && req.body.key;
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
    `SELECT ci.instance_id, ci.level, ci.xp, ci.favorite, ci.locked, ci.obtained_at,
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
  const u = await getUser(req.userId);
  if (u.dust < cost.dust || u.coins < cost.coins) return res.status(402).json({ error: "insufficient" });
  await db.query("UPDATE users SET dust=dust-$1, coins=coins-$2 WHERE id=$3", [cost.dust, cost.coins, u.id]);
  await db.query("UPDATE creature_instances SET level=level+1 WHERE instance_id=$1", [inst.instance_id]);
  res.json({ level: inst.level + 1, cost });
}));

app.post("/creature/:id/release", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT ci.*, t.rarity FROM creature_instances ci JOIN creature_templates t ON t.template_id=ci.template_id WHERE ci.instance_id=$1 AND ci.user_id=$2", [req.params.id, req.userId]);
  const inst = r.rows[0];
  if (!inst) return res.status(404).json({ error: "not_found" });
  if (inst.locked) return res.status(400).json({ error: "locked" });
  const team = await db.query("SELECT 1 FROM teams WHERE user_id=$1 AND (slot1=$2 OR slot2=$2 OR slot3=$2)", [req.userId, inst.instance_id]);
  if (team.rowCount) return res.status(400).json({ error: "in_team" });
  const dust = C.RELEASE_DUST[inst.rarity] || 5;
  await db.query("DELETE FROM creature_instances WHERE instance_id=$1", [inst.instance_id]);
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
  await db.query(
    `INSERT INTO teams (user_id, slot1, slot2, slot3, snapshot, updated_at)
     VALUES ($1,$2,$3,$4,$5, now())
     ON CONFLICT (user_id) DO UPDATE SET slot1=$2, slot2=$3, slot3=$4, snapshot=$5, updated_at=now()`,
    [req.userId, ordered[0] || null, ordered[1] || null, ordered[2] || null, JSON.stringify(snapshot)]
  );
  res.json({ slots: ordered });
}));

// ---------------------------------- BATTLE -----------------------------------
// Construye unidades B desde el snapshot de un equipo de otro jugador.
async function opponentFromSnapshot(snapshot) {
  // snapshot: [{template_id, level}]
  const ids = snapshot.map((s) => s.template_id);
  const r = await db.query(
    "SELECT template_id, name, type, type2, ability_id, base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s FROM creature_templates WHERE template_id = ANY($1)",
    [ids]
  );
  const byId = {}; r.rows.forEach((x) => (byId[x.template_id] = x));
  const out = [];
  snapshot.forEach((s, i) => {
    const t = byId[s.template_id];
    if (!t) return;
    const tplLike = { id: t.template_id, name: t.name, type: t.type, types: tplTypes(t), ability: t.ability_id, base_stats: tplBaseStats(t) };
    out.push(combat.buildUnit(tplLike, s.level, "B", out.length));
  });
  return out;
}

const STANCES_OK = ["NEUTRAL", "AGRESIVA", "DEFENSIVA"];
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

  // PvP asíncrono: busca el snapshot de un rival de liga similar; si no hay, bot.
  let B = [];
  let defenderId = null;
  const rival = await db.query(
    `SELECT t.user_id, t.snapshot
       FROM teams t JOIN users u ON u.id = t.user_id
      WHERE t.user_id <> $1 AND t.snapshot IS NOT NULL AND jsonb_array_length(t.snapshot) > 0
      ORDER BY abs(u.league_points - $2) ASC, random()
      LIMIT 10`,
    [req.userId, me.league_points]
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

  const off = await db.query(
    "SELECT * FROM battle_offers WHERE id=$1 AND attacker_id=$2 AND consumed=false",
    [battleId, req.userId]
  );
  if (!off.rowCount) return res.status(404).json({ error: "offer_not_found" });
  const offer = off.rows[0];

  let u = await getUser(req.userId);
  u = await syncEnergy(u);
  if (u.energy < 1) return res.status(402).json({ error: "no_energy" });

  // Reconstruye AMBOS equipos desde la oferta congelada (igual que vio el cliente).
  const frozen = offer.opponent; // { team:[...], opponent:[...] }
  const A = frozen.team.map((s, i) => combat.unitFromStats(s, "A", i));
  const B = frozen.opponent.map((s, i) => combat.unitFromStats(s, "B", i));

  const result = combat.resolveBattle(A, B, offer.seed | 0, safeDecisions);
  const win = result.winner === "A";
  const abilitiesUsed = result.log.filter((e) => e.ability && e.uid[0] === "A").length;

  // Marca la oferta consumida (atómico: una oferta = un combate).
  await db.query("UPDATE battle_offers SET consumed=true WHERE id=$1", [battleId]);

  const coins = win ? 40 : 8;
  const lpDelta = win ? 12 : -6;
  const newLp = Math.max(0, u.league_points + lpDelta);
  const league = C.computeLeague(newLp);
  const newEnergy = u.energy - 1;
  // Si baja del máximo, (re)inicia el contador de regeneración desde ahora.
  const energyAt = newEnergy < C.ENERGY_MAX ? new Date() : u.energy_updated_at;
  await db.query(
    "UPDATE users SET energy=$1, energy_updated_at=$2, coins=coins+$3, league_points=$4, league=$5 WHERE id=$6",
    [newEnergy, energyAt, coins, newLp, league, u.id]
  );
  await db.query("INSERT INTO battles (attacker_id, defender_id, seed, result, daily_date) VALUES ($1,$2,$3,$4,$5)",
    [u.id, offer.defender_id, offer.seed | 0, win ? "WIN" : "LOSS", C.todayStr()]);
  if (win) {
    await db.query(
      `INSERT INTO daily_scores (daily_date, user_id, wins) VALUES ($1,$2,1)
       ON CONFLICT (daily_date, user_id) DO UPDATE SET wins = daily_scores.wins + 1`,
      [C.todayStr(), u.id]
    );
    await bumpMission(u.id, "wins", 1);
  }
  if (abilitiesUsed > 0) await bumpMission(u.id, "abilities", abilitiesUsed);

  res.json({ win, coins, leaguePoints: newLp, league, energy: newEnergy, log: result.log, turns: result.turns, pvp: !!offer.defender_id });
}));

// --------------------------------- RANKINGS ----------------------------------
app.get("/rankings/daily", authMiddleware, wrap(async (req, res) => {
  const r = await db.query(
    `SELECT u.display_name AS name, ds.wins, ds.user_id
       FROM daily_scores ds JOIN users u ON u.id=ds.user_id
      WHERE ds.daily_date=$1 ORDER BY ds.wins DESC LIMIT 50`,
    [C.todayStr()]
  );
  res.json(r.rows.map((x, i) => ({ pos: i + 1, name: x.name, score: x.wins, me: x.user_id === req.userId })));
}));
app.get("/rankings/league", authMiddleware, wrap(async (req, res) => {
  const r = await db.query("SELECT id, display_name AS name, league, league_points FROM users ORDER BY league_points DESC LIMIT 50");
  res.json(r.rows.map((x, i) => ({ pos: i + 1, name: x.name, league: x.league, score: x.league_points, me: x.id === req.userId })));
}));

// ----------------------------------- SHOP ------------------------------------
app.post("/shop/roll", authMiddleware, wrap(async (req, res) => {
  let u = await getUser(req.userId);
  if (!u.rolls_date || C.todayStr(new Date(u.rolls_date)) !== C.todayStr()) {
    await db.query("UPDATE users SET rolls_today=0, rolls_date=$1 WHERE id=$2", [C.todayStr(), u.id]);
    u.rolls_today = 0;
  }
  if (u.rolls_today >= 10) return res.status(429).json({ error: "daily_cap" });
  if (u.coins < 100) return res.status(402).json({ error: "insufficient" });
  const list = await todayTemplates();
  const t = list[Math.floor(Math.random() * list.length)];
  const ins = await db.query("INSERT INTO creature_instances (user_id, template_id) VALUES ($1,$2) RETURNING instance_id", [u.id, t.id]);
  await db.query("UPDATE users SET coins=coins-100, rolls_today=rolls_today+1 WHERE id=$1", [u.id]);
  res.json({ instance_id: ins.rows[0].instance_id, template: t });
}));

// Compra de gemas / cosméticos. En producción valida el recibo de tienda
// (App Store / Google Play) antes de conceder. Aquí: stub controlado por env.
app.post("/shop/purchase", authMiddleware, wrap(async (req, res) => {
  const { sku } = req.body || {};
  const CATALOG = { gems_small: { gems: 50 }, pass: { gems: 20, pass: true }, energy_refill: { energy: C.ENERGY_MAX } };
  const item = CATALOG[sku];
  if (!item) return res.status(400).json({ error: "bad_sku" });
  if (process.env.ALLOW_STUB_PURCHASES !== "true") {
    return res.status(501).json({ error: "receipt_validation_required" });
  }
  if (item.gems) await db.query("UPDATE users SET gems=gems+$1 WHERE id=$2", [item.gems, req.userId]);
  if (item.energy) await db.query("UPDATE users SET energy=$1, energy_updated_at=now() WHERE id=$2", [item.energy, req.userId]);
  const u = await getUser(req.userId);
  res.json(userPublic(u));
}));

// ---------------------------------- FUSION -----------------------------------
app.post("/fusion", authMiddleware, wrap(async (req, res) => {
  const { a, b } = req.body || {};
  if (!a || !b || a === b) return res.status(400).json({ error: "need_two_distinct" });
  try {
    const out = await fuse(req.userId, a, b);
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
    res.json(await dungeon.startRun(req.userId, A));
  } catch (e) { dungeonErr(res, e); }
}));
app.get("/dungeon", authMiddleware, wrap(async (req, res) => {
  res.json(await dungeon.getRun(req.userId) || { status: "none" });
}));
app.post("/dungeon/choose", authMiddleware, wrap(async (req, res) => {
  try {
    const tpls = await todayTemplates();
    const base = teamAvgLevel(await buildTeamUnits(req.userId));
    res.json(await dungeon.chooseNode(req.userId, (req.body && req.body.choice) | 0, tpls, base));
  } catch (e) { dungeonErr(res, e); }
}));
app.post("/dungeon/battle", authMiddleware, wrap(async (req, res) => {
  try { res.json(await dungeon.resolveCombat(req.userId, (req.body && req.body.decisions) || [])); }
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
  res.json(await dungeon.ranking(req.userId));
}));

// --------------------------------- HEALTH ------------------------------------
app.get("/health", wrap(async (req, res) => {
  await db.query("SELECT 1");
  res.json({ ok: true, date: C.todayStr() });
}));

// --------------------------- manejo de errores -------------------------------
app.use((req, res) => res.status(404).json({ error: "not_found" }));
app.use((err, req, res, next) => {
  console.error("[error]", err.message);
  res.status(500).json({ error: "server_error" });
});

// --------------------------------- arranque ----------------------------------
const PORT = process.env.PORT || 3000;
let server;
if (require.main === module) {
  // Escuchar en 0.0.0.0 (requisito de Railway/PaaS para que el proxy llegue a la app).
  server = app.listen(PORT, "0.0.0.0", () => console.log(`AIGRONS API escuchando en 0.0.0.0:${PORT} (frontend en /)`));
  startCron(generateDailyBatch, DAILY_N);

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
