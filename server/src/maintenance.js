// =============================================================================
// maintenance.js — Tareas de higiene de datos para que las tablas de alta
// rotación no crezcan sin límite (a millones de usuarios/día esto es lo primero
// que tumba la base de datos). Se ejecuta al arrancar y a diario por cron.
//
// Retenciones (días, configurables por env):
//   battle_offers   consumidas o de >1 día (eran de un solo uso)
//   battles         RETAIN_BATTLES_DAYS   (30)  — histórico/replays recientes
//   daily_missions  RETAIN_MISSIONS_DAYS  (14)  — solo importa el día corriente
//   daily_scores    RETAIN_SCORES_DAYS    (90)  — rankings diarios pasados
//   dungeon_scores  RETAIN_SCORES_DAYS    (90)
//   dungeon_runs    runs de días pasados (la run solo vale para el día de su mapa)
// =============================================================================
const leagues = require("./leagues");

const DAYS = (env, def) => parseInt(process.env[env] || String(def), 10);

async function cleanupOldData(db) {
  const out = {};
  const run = async (label, sql, params) => {
    const r = await db.query(sql, params);
    out[label] = r.rowCount;
  };
  await run("battle_offers", "DELETE FROM battle_offers WHERE consumed = true OR created_at < now() - interval '1 day'");
  await run("battles", `DELETE FROM battles WHERE created_at < now() - make_interval(days => $1)`, [DAYS("RETAIN_BATTLES_DAYS", 30)]);
  await run("daily_missions", `DELETE FROM daily_missions WHERE daily_date < CURRENT_DATE - $1::int`, [DAYS("RETAIN_MISSIONS_DAYS", 14)]);
  await run("daily_scores", `DELETE FROM daily_scores WHERE daily_date < CURRENT_DATE - $1::int`, [DAYS("RETAIN_SCORES_DAYS", 90)]);
  await run("dungeon_scores", `DELETE FROM dungeon_scores WHERE daily_date < CURRENT_DATE - $1::int`, [DAYS("RETAIN_SCORES_DAYS", 90)]);
  await run("dungeon_runs", "DELETE FROM dungeon_runs WHERE daily_date < CURRENT_DATE - 1");
  const total = Object.values(out).reduce((a, b) => a + b, 0);
  if (total > 0) console.log("[limpieza]", JSON.stringify(out));
  return out;
}

// Arranca limpieza + cierre semanal de ligas: una pasada al arrancar (catch-up
// tras estar caído) y cron diario. Respeta DISABLE_CRON para entornos con cron
// del SO; en ese caso expón las tareas vía scripts si las necesitas.
function startMaintenance(db) {
  const boot = async () => {
    try { await leagues.closeWeekIfDue(db); } catch (e) { console.error("[ligas] error:", e.message); }
    try { await cleanupOldData(db); } catch (e) { console.error("[limpieza] error:", e.message); }
  };
  boot();
  if (process.env.DISABLE_CRON === "true") return null;
  let cron;
  try { cron = require("node-cron"); } catch (e) { return null; }
  const tz = process.env.CRON_TZ || "UTC";
  const task = cron.schedule("10 4 * * *", boot, { timezone: tz });
  console.log(`[mantenimiento] activo: limpieza + cierre de ligas a las 04:10 (${tz})`);
  return task;
}

module.exports = { cleanupOldData, startMaintenance };
