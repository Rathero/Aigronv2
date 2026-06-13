// =============================================================================
// guilds.js — CONSTELACIONES (gremios, #1).
//
// Capa social: los jugadores forman constelaciones y compiten en un ranking de
// constelaciones. El "poder" se AGREGA de stats existentes de los miembros
// (SUM de league_points), así que no hace falta ningún hook de escritura nuevo
// en el bucle de combate: el ranking sale de un GROUP BY sobre users.
//
// Pertenencia: users.guild_id (un jugador, una constelación). Operaciones
// atómicas con UPDATE condicional (sin transacción larga): crear cobra monedas
// y reserva el nombre; unirse respeta el aforo; salir transfiere el liderazgo
// o disuelve la constelación si queda vacía.
// =============================================================================
const db = require("./db");
const auth = require("./auth");
const C = require("./config");
const { weekStart } = require("./leagues");

const GUILD_COST = parseInt(process.env.GUILD_COST || "200", 10); // monedas para fundar (anti-spam)
const GUILD_MAX_MEMBERS = 20; // aforo
const GUILD_WEEK_REWARD = { coins: 200, dust: 40 };
const weekKey = () => C.todayStr(weekStart());
// Objetivo semanal que escala con el tamaño: constelaciones grandes, más reto.
const guildWeekGoal = (members) => Math.max(20, members * 8);

function cleanTag(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

// Funda una constelación: valida, cobra (atómico), reserva el nombre y une al fundador.
async function createGuild(userId, nameRaw, tagRaw) {
  const name = auth.sanitizeName(nameRaw || "");
  const tag = cleanTag(tagRaw);
  if (!/^.{3,20}$/.test(name)) return { error: "bad_name" };
  if (!/^[A-Z0-9]{2,4}$/.test(tag)) return { error: "bad_tag" };
  const u = await db.query("SELECT guild_id FROM users WHERE id=$1", [userId]);
  if (!u.rowCount) return { error: "no_user" };
  if (u.rows[0].guild_id) return { error: "already_in_guild" };
  const ex = await db.query("SELECT 1 FROM guilds WHERE lower(name)=lower($1)", [name]);
  if (ex.rowCount) return { error: "name_taken" };
  // Cobro atómico (y reconfirma que sigue sin constelación en la misma sentencia).
  const pay = await db.query(
    "UPDATE users SET coins=coins-$1 WHERE id=$2 AND coins>=$1 AND guild_id IS NULL RETURNING id",
    [GUILD_COST, userId]
  );
  if (!pay.rowCount) return { error: "insufficient" };
  let g;
  try {
    g = await db.query("INSERT INTO guilds (name, tag, owner_id) VALUES ($1,$2,$3) RETURNING id", [name, tag, userId]);
  } catch (e) {
    await db.query("UPDATE users SET coins=coins+$1 WHERE id=$2", [GUILD_COST, userId]).catch(() => {}); // devolver cobro
    if (/idx_guilds_name|unique/i.test(e.message)) return { error: "name_taken" };
    throw e;
  }
  await db.query("UPDATE users SET guild_id=$1, guild_joined_at=now() WHERE id=$2", [g.rows[0].id, userId]);
  return { id: g.rows[0].id, cost: GUILD_COST };
}

// Únete a una constelación si no estás en otra y hay sitio (aforo blando).
async function joinGuild(userId, guildId) {
  const g = await db.query("SELECT id FROM guilds WHERE id=$1", [guildId]);
  if (!g.rowCount) return { error: "no_guild" };
  const cnt = await db.query("SELECT COUNT(*)::int AS n FROM users WHERE guild_id=$1", [guildId]);
  if (cnt.rows[0].n >= GUILD_MAX_MEMBERS) return { error: "full" };
  const upd = await db.query(
    "UPDATE users SET guild_id=$1, guild_joined_at=now() WHERE id=$2 AND guild_id IS NULL RETURNING id",
    [guildId, userId]
  );
  if (!upd.rowCount) return { error: "already_in_guild" };
  return { id: guildId };
}

// Sal de tu constelación. Si eras el líder: traspasa al miembro más antiguo, o
// disuelve la constelación si no queda nadie.
async function leaveGuild(userId) {
  const u = await db.query("SELECT guild_id FROM users WHERE id=$1", [userId]);
  const gid = u.rows[0] && u.rows[0].guild_id;
  if (!gid) return { error: "not_in_guild" };
  await db.query("UPDATE users SET guild_id=NULL, guild_joined_at=NULL WHERE id=$1", [userId]);
  const g = await db.query("SELECT owner_id FROM guilds WHERE id=$1", [gid]);
  if (g.rowCount && g.rows[0].owner_id === userId) {
    const next = await db.query(
      "SELECT id FROM users WHERE guild_id=$1 ORDER BY guild_joined_at NULLS LAST, created_at LIMIT 1", [gid]);
    if (next.rowCount) await db.query("UPDATE guilds SET owner_id=$1 WHERE id=$2", [next.rows[0].id, gid]);
    else await db.query("DELETE FROM guilds WHERE id=$1", [gid]);
  }
  return { ok: true };
}

// Tu constelación: info + miembros (por puntos) + tu rango entre constelaciones.
async function myGuild(userId) {
  const u = await db.query("SELECT guild_id FROM users WHERE id=$1", [userId]);
  const gid = u.rows[0] && u.rows[0].guild_id;
  if (!gid) return { guild: null };
  const g = await db.query("SELECT id, name, tag, owner_id, created_at FROM guilds WHERE id=$1", [gid]);
  if (!g.rowCount) { await db.query("UPDATE users SET guild_id=NULL WHERE id=$1", [userId]); return { guild: null }; }
  const members = await db.query(
    "SELECT id, display_name, league, league_points, total_wins FROM users WHERE guild_id=$1 ORDER BY league_points DESC LIMIT 50", [gid]);
  const power = members.rows.reduce((a, m) => a + (m.league_points || 0), 0);
  const wins = members.rows.reduce((a, m) => a + (m.total_wins || 0), 0);
  const rank = await db.query(
    `WITH gp AS (SELECT guild_id, SUM(league_points) AS p FROM users WHERE guild_id IS NOT NULL GROUP BY guild_id)
     SELECT 1 + COUNT(*)::int AS pos FROM gp WHERE p > COALESCE((SELECT p FROM gp WHERE guild_id=$1), 0)`, [gid]);
  const owner = g.rows[0].owner_id;
  return {
    guild: { id: g.rows[0].id, name: g.rows[0].name, tag: g.rows[0].tag, ownerId: owner,
      memberCount: members.rowCount, power, wins, rank: rank.rows[0] ? rank.rows[0].pos : null, max: GUILD_MAX_MEMBERS },
    members: members.rows.map((m) => ({
      id: m.id, name: m.display_name, league: m.league, leaguePoints: m.league_points,
      wins: m.total_wins || 0, owner: m.id === owner, me: m.id === userId,
    })),
    isOwner: owner === userId,
  };
}

// Top de constelaciones por poder agregado (con nº de miembros).
async function listGuilds(limit) {
  const r = await db.query(
    `SELECT g.id, g.name, g.tag, COUNT(u.id)::int AS members, COALESCE(SUM(u.league_points), 0)::int AS power
       FROM guilds g LEFT JOIN users u ON u.guild_id = g.id
      GROUP BY g.id ORDER BY power DESC, members DESC, g.created_at ASC LIMIT $1`, [limit || 30]);
  return r.rows.map((x, i) => ({ pos: i + 1, id: x.id, name: x.name, tag: x.tag, members: x.members, power: x.power, full: x.members >= GUILD_MAX_MEMBERS }));
}

// --------------------------- MISIÓN SEMANAL ---------------------------------
// Progreso = SUMA de las victorias PvP semanales de los miembros (reusa
// weekly_missions.wins; sin hooks nuevos). Recompensa reclamable una vez por
// miembro y semana cuando la constelación alcanza el objetivo.
async function guildWeekly(userId) {
  const u = await db.query("SELECT guild_id FROM users WHERE id=$1", [userId]);
  const gid = u.rows[0] && u.rows[0].guild_id;
  if (!gid) return { error: "not_in_guild" };
  const wk = weekKey();
  const agg = await db.query(
    `SELECT COALESCE(SUM(wm.wins), 0)::int AS wins, COUNT(DISTINCT m.id)::int AS members
       FROM users m LEFT JOIN weekly_missions wm ON wm.user_id = m.id AND wm.week_start = $2
      WHERE m.guild_id = $1`, [gid, wk]);
  const members = agg.rows[0].members || 1;
  const progress = agg.rows[0].wins;
  const goal = guildWeekGoal(members);
  const claimed = await db.query("SELECT 1 FROM guild_week_claims WHERE guild_id=$1 AND week_start=$2 AND user_id=$3", [gid, wk, userId]);
  return {
    progress, goal, members, done: progress >= goal, claimed: claimed.rowCount > 0,
    reward: GUILD_WEEK_REWARD, label: `Ganad ${goal} combates entre toda la constelación esta semana`,
  };
}

async function claimGuildWeekly(userId) {
  const w = await guildWeekly(userId);
  if (w.error) return w;
  if (!w.done) return { error: "not_done" };
  if (w.claimed) return { error: "already_claimed" };
  const u = await db.query("SELECT guild_id FROM users WHERE id=$1", [userId]);
  const gid = u.rows[0].guild_id, wk = weekKey();
  // INSERT condicional = barrera atómica anti doble cobro.
  const ins = await db.query(
    "INSERT INTO guild_week_claims (guild_id, week_start, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING user_id", [gid, wk, userId]);
  if (!ins.rowCount) return { error: "already_claimed" };
  await db.query("UPDATE users SET coins=coins+$1, dust=dust+$2 WHERE id=$3", [GUILD_WEEK_REWARD.coins, GUILD_WEEK_REWARD.dust, userId]);
  return { reward: GUILD_WEEK_REWARD };
}

// ------------------------------- MURO / CHAT --------------------------------
async function postMessage(userId, bodyRaw) {
  const u = await db.query("SELECT guild_id, display_name FROM users WHERE id=$1", [userId]);
  const gid = u.rows[0] && u.rows[0].guild_id;
  if (!gid) return { error: "not_in_guild" };
  const body = String(bodyRaw || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!body) return { error: "empty" };
  // Rate limit blando: 1 mensaje cada 3s por usuario.
  const last = await db.query("SELECT created_at FROM guild_messages WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1", [userId]);
  if (last.rowCount && Date.now() - new Date(last.rows[0].created_at).getTime() < 3000) return { error: "too_fast" };
  await db.query("INSERT INTO guild_messages (guild_id, user_id, name, body) VALUES ($1,$2,$3,$4)", [gid, userId, u.rows[0].display_name, body]);
  // Poda: conserva los últimos 100 del muro.
  await db.query(
    "DELETE FROM guild_messages WHERE guild_id=$1 AND id NOT IN (SELECT id FROM guild_messages WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 100)", [gid]);
  return { ok: true };
}

async function listMessages(userId) {
  const u = await db.query("SELECT guild_id FROM users WHERE id=$1", [userId]);
  const gid = u.rows[0] && u.rows[0].guild_id;
  if (!gid) return { error: "not_in_guild" };
  const r = await db.query("SELECT name, body, created_at, user_id FROM guild_messages WHERE guild_id=$1 ORDER BY created_at DESC LIMIT 30", [gid]);
  return { messages: r.rows.map((x) => ({ name: x.name, body: x.body, at: x.created_at, me: x.user_id === userId })) };
}

module.exports = { createGuild, joinGuild, leaveGuild, myGuild, listGuilds,
  guildWeekly, claimGuildWeekly, postMessage, listMessages, GUILD_COST, GUILD_MAX_MEMBERS };
