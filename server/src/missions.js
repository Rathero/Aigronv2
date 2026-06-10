// =============================================================================
// missions.js — Misiones SEMANALES (las diarias viven en app.js/daily_missions).
// Las diarias retienen el día; estas dan un objetivo de semana con recompensa
// gorda. La semana es la misma que el cierre de ligas (lunes, hora del servidor).
// =============================================================================
const C = require("./config");
const db = require("./db");
const { weekStart } = require("./leagues");

const WEEKLY = {
  w_wins:    { goal: 15, reward: 250, col: "wins",          flag: "claimed_wins",    mode: "inc", label: "Gana 15 combates" },
  w_dungeon: { goal: 5,  reward: 200, col: "dungeon_depth", flag: "claimed_dungeon", mode: "max", label: "Llega al nodo 5 de la mazmorra" },
  w_fusions: { goal: 2,  reward: 150, col: "fusions",       flag: "claimed_fusions", mode: "inc", label: "Fusiona 2 veces" },
};
const wkStr = () => C.todayStr(weekStart());

async function ensureRow(userId) {
  await db.query(
    `INSERT INTO weekly_missions (user_id, week_start) VALUES ($1,$2)
     ON CONFLICT (user_id, week_start) DO NOTHING`,
    [userId, wkStr()]
  );
}
// mode 'inc' suma; mode 'max' guarda el máximo (p. ej. mejor profundidad).
async function bumpWeekly(userId, key, n) {
  const def = WEEKLY[key];
  if (!def) return;
  await ensureRow(userId);
  const expr = def.mode === "max" ? `GREATEST(${def.col}, $1)` : `${def.col} + $1`;
  await db.query(
    `UPDATE weekly_missions SET ${def.col} = ${expr} WHERE user_id=$2 AND week_start=$3`,
    [n, userId, wkStr()]
  );
}
async function weeklyPublic(userId) {
  await ensureRow(userId);
  const r = await db.query("SELECT * FROM weekly_missions WHERE user_id=$1 AND week_start=$2", [userId, wkStr()]);
  const m = r.rows[0];
  return Object.entries(WEEKLY).map(([key, def]) => ({
    key, label: def.label, scope: "weekly",
    progress: Math.min(m[def.col], def.goal), goal: def.goal, reward: def.reward,
    done: m[def.col] >= def.goal, claimed: m[def.flag],
  }));
}
// Reclamo atómico (el UPDATE condicional del flag es la barrera anti doble cobro).
async function claimWeekly(userId, key) {
  const def = WEEKLY[key];
  if (!def) return { error: "bad_mission" };
  await ensureRow(userId);
  const r = await db.query(
    `UPDATE weekly_missions SET ${def.flag}=true
      WHERE user_id=$1 AND week_start=$2 AND ${def.col} >= $3 AND ${def.flag}=false
      RETURNING user_id`,
    [userId, wkStr(), def.goal]
  );
  if (!r.rowCount) return { error: "not_done_or_claimed" };
  await db.query("UPDATE users SET coins=coins+$1 WHERE id=$2", [def.reward, userId]);
  return { key, reward: def.reward };
}

module.exports = { WEEKLY, bumpWeekly, weeklyPublic, claimWeekly };
