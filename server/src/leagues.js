// =============================================================================
// leagues.js — Cierre SEMANAL de ligas (retención): cada lunes se reparte la
// recompensa de la liga alcanzada, se guarda el histórico (league_weeks) y los
// puntos se comprimen hacia el suelo de la liga (soft-reset: conservas la liga,
// pierdes la mitad del progreso dentro de ella -> hay algo que ganar cada semana).
//
// Idempotente y seguro multi-instancia: advisory lock + marca en app_meta.
// Se ejecuta al arrancar y a diario por cron (solo actúa si la semana cambió).
// =============================================================================
const C = require("./config");

// Suelos de liga (deben coincidir con computeLeague del motor).
const FLOORS = { BRONCE: 0, PLATA: 100, ORO: 250, PLATINO: 450, DIAMANTE: 700 };
// Recompensa semanal por liga (solo jugadores con puntos: los inactivos a 0 no cobran).
const REWARDS = {
  BRONCE: { coins: 50, gems: 0 }, PLATA: { coins: 120, gems: 1 }, ORO: { coins: 250, gems: 2 },
  PLATINO: { coins: 400, gems: 4 }, DIAMANTE: { coins: 600, gems: 6 },
};

// Lunes (00:00 local del servidor) de la semana de `d`.
function weekStart(d) {
  d = d || new Date();
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function nextCloseAt() {
  const ws = weekStart();
  return new Date(ws.getFullYear(), ws.getMonth(), ws.getDate() + 7).toISOString();
}

// Cierra la semana si toca. Devuelve true si cerró.
async function closeWeekIfDue(db) {
  const thisWeek = C.todayStr(weekStart());
  const r = await db.query("SELECT value FROM app_meta WHERE key='league_week_closed'");
  if (r.rowCount && r.rows[0].value === thisWeek) return false;

  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('league_close'))");
    const again = await client.query("SELECT value FROM app_meta WHERE key='league_week_closed'");
    if (again.rowCount && again.rows[0].value === thisWeek) { await client.query("ROLLBACK"); return false; }

    const caseCoins = `CASE league WHEN 'DIAMANTE' THEN ${REWARDS.DIAMANTE.coins} WHEN 'PLATINO' THEN ${REWARDS.PLATINO.coins} WHEN 'ORO' THEN ${REWARDS.ORO.coins} WHEN 'PLATA' THEN ${REWARDS.PLATA.coins} ELSE ${REWARDS.BRONCE.coins} END`;
    const caseGems = `CASE league WHEN 'DIAMANTE' THEN ${REWARDS.DIAMANTE.gems} WHEN 'PLATINO' THEN ${REWARDS.PLATINO.gems} WHEN 'ORO' THEN ${REWARDS.ORO.gems} WHEN 'PLATA' THEN ${REWARDS.PLATA.gems} ELSE ${REWARDS.BRONCE.gems} END`;
    const caseFloor = `CASE league WHEN 'DIAMANTE' THEN ${FLOORS.DIAMANTE} WHEN 'PLATINO' THEN ${FLOORS.PLATINO} WHEN 'ORO' THEN ${FLOORS.ORO} WHEN 'PLATA' THEN ${FLOORS.PLATA} ELSE ${FLOORS.BRONCE} END`;

    // Histórico de la semana que se cierra (para salón de la fama / perfil).
    await client.query(
      `INSERT INTO league_weeks (week_start, user_id, league, points, reward_coins, reward_gems)
       SELECT $1, id, league, league_points, ${caseCoins}, ${caseGems}
         FROM users WHERE league_points > 0
       ON CONFLICT (week_start, user_id) DO NOTHING`,
      [thisWeek]
    );
    // Recompensa + soft-reset: lp' = suelo + (lp - suelo) / 2 (la liga no cambia).
    const upd = await client.query(
      `UPDATE users SET
         coins = coins + ${caseCoins},
         gems  = gems + ${caseGems},
         league_points = ${caseFloor} + (league_points - ${caseFloor}) / 2
       WHERE league_points > 0`
    );
    await client.query(
      `INSERT INTO app_meta (key, value) VALUES ('league_week_closed', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`,
      [thisWeek]
    );
    await client.query("COMMIT");
    console.log(`[ligas] semana cerrada (${thisWeek}): ${upd.rowCount} jugadores recompensados y comprimidos`);
    return true;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { closeWeekIfDue, nextCloseAt, REWARDS, FLOORS, weekStart };
