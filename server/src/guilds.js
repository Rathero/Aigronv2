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

const GUILD_COST = parseInt(process.env.GUILD_COST || "200", 10); // monedas para fundar (anti-spam)
const GUILD_MAX_MEMBERS = 20; // aforo

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

module.exports = { createGuild, joinGuild, leaveGuild, myGuild, listGuilds, GUILD_COST, GUILD_MAX_MEMBERS };
