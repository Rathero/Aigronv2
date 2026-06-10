// =============================================================================
// achievements.js — Logros de largo plazo. El PROGRESO se deriva de contadores
// que ya mantenemos (users.total_wins, best_streak, …); en la tabla solo se
// guarda lo RECLAMADO (insert con PK = barrera atómica anti doble cobro).
// =============================================================================
const db = require("./db");

const LEAGUE_ORD = { BRONCE: 0, PLATA: 1, ORO: 2, PLATINO: 3, DIAMANTE: 4 };
const DEFS = [
  { key: "wins10",   name: "Guerrero",      desc: "Gana 10 combates",            goal: 10,  stat: (u) => u.total_wins,                    reward: { coins: 100 } },
  { key: "wins50",   name: "Veterano",      desc: "Gana 50 combates",            goal: 50,  stat: (u) => u.total_wins,                    reward: { coins: 300, gems: 1 } },
  { key: "wins200",  name: "Campeón",       desc: "Gana 200 combates",           goal: 200, stat: (u) => u.total_wins,                    reward: { coins: 800, gems: 4 } },
  { key: "streak7",  name: "Constante",     desc: "Racha diaria de 7 días",      goal: 7,   stat: (u) => u.best_streak,                   reward: { coins: 200, gems: 1 } },
  { key: "streak30", name: "Devoto",        desc: "Racha diaria de 30 días",     goal: 30,  stat: (u) => u.best_streak,                   reward: { coins: 600, gems: 5 } },
  { key: "col15",    name: "Coleccionista", desc: "Ten 15 aigrons a la vez",     goal: 15,  stat: (u, ex) => ex.collection,               reward: { coins: 150 } },
  { key: "col50",    name: "Archivista",    desc: "Ten 50 aigrons a la vez",     goal: 50,  stat: (u, ex) => ex.collection,               reward: { coins: 400, gems: 2 } },
  { key: "fusion1",  name: "Alquimista",    desc: "Haz tu primera fusión",       goal: 1,   stat: (u) => u.fusions_done,                  reward: { coins: 100 } },
  { key: "fusion10", name: "Mutágeno",      desc: "Haz 10 fusiones",             goal: 10,  stat: (u) => u.fusions_done,                  reward: { coins: 350, gems: 2 } },
  { key: "dgclear1", name: "Profanador",    desc: "Completa una mazmorra",       goal: 1,   stat: (u) => u.dungeons_cleared,              reward: { coins: 200 } },
  { key: "dgclear10",name: "Cartógrafo",    desc: "Completa 10 mazmorras",       goal: 10,  stat: (u) => u.dungeons_cleared,              reward: { coins: 500, gems: 3 } },
  { key: "plata",    name: "Ascenso",       desc: "Alcanza la liga PLATA",       goal: 1,   stat: (u) => (LEAGUE_ORD[u.best_league] >= 1 ? 1 : 0), reward: { coins: 150 } },
  { key: "oro",      name: "Dorado",        desc: "Alcanza la liga ORO",         goal: 1,   stat: (u) => (LEAGUE_ORD[u.best_league] >= 2 ? 1 : 0), reward: { coins: 300, gems: 1 } },
  { key: "diamante", name: "Imparable",     desc: "Alcanza la liga DIAMANTE",    goal: 1,   stat: (u) => (LEAGUE_ORD[u.best_league] >= 4 ? 1 : 0), reward: { coins: 800, gems: 5 } },
];

async function extras(userId) {
  const c = await db.query("SELECT COUNT(*)::int AS n FROM creature_instances WHERE user_id=$1", [userId]);
  return { collection: c.rows[0].n };
}

async function list(userId, user) {
  const ex = await extras(userId);
  const cl = await db.query("SELECT key FROM achievements WHERE user_id=$1", [userId]);
  const claimed = new Set(cl.rows.map((x) => x.key));
  return DEFS.map((d) => {
    const p = d.stat(user, ex);
    return { key: d.key, name: d.name, desc: d.desc, goal: d.goal,
      progress: Math.min(p, d.goal), done: p >= d.goal, claimed: claimed.has(d.key), reward: d.reward };
  });
}

async function claim(userId, user, key) {
  const d = DEFS.find((x) => x.key === key);
  if (!d) return { error: "bad_achievement" };
  const ex = await extras(userId);
  if (d.stat(user, ex) < d.goal) return { error: "not_done" };
  const ins = await db.query(
    "INSERT INTO achievements (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING key",
    [userId, key]
  );
  if (!ins.rowCount) return { error: "already_claimed" };
  await db.query("UPDATE users SET coins=coins+$1, gems=gems+$2 WHERE id=$3",
    [d.reward.coins || 0, d.reward.gems || 0, userId]);
  return { key, reward: d.reward };
}

module.exports = { DEFS, list, claim };
