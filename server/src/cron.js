// =============================================================================
// cron.js — Generación nocturna del lote en proceso (alternativa al cron del SO).
//
// Programa la generación del lote de MAÑANA (doc §6.5 / README §8). Usa la
// dependencia opcional `node-cron`; si no está instalada o DISABLE_CRON=true,
// no hace nada (puedes usar el cron del sistema con scripts/generate-today.js).
//
//   CRON_GENERATE   expresión cron (defecto "0 3 * * *" = 03:00 cada día)
//   CRON_TZ         zona horaria (defecto "UTC")
//   DISABLE_CRON    "true" para desactivar el cron en proceso
// =============================================================================
const C = require("./config");

function tomorrowStr() {
  return C.todayStr(new Date(Date.now() + 86400000));
}

function startCron(generateDailyBatch, dailyN) {
  if (process.env.DISABLE_CRON === "true") {
    console.log("[cron] desactivado (DISABLE_CRON=true)");
    return null;
  }
  let cron;
  try {
    cron = require("node-cron");
  } catch (e) {
    console.log("[cron] node-cron no instalado; usa el cron del SO con scripts/generate-today.js");
    return null;
  }
  const expr = process.env.CRON_GENERATE || "0 3 * * *";
  const tz = process.env.CRON_TZ || "UTC";
  if (!cron.validate(expr)) {
    console.warn(`[cron] expresión inválida "${expr}", cron desactivado`);
    return null;
  }
  const task = cron.schedule(
    expr,
    async () => {
      const date = tomorrowStr();
      try {
        console.log(`[cron] generando lote de ${date}...`);
        await generateDailyBatch(date, dailyN);
      } catch (e) {
        console.error(`[cron] error generando ${date}:`, e.message);
      }
    },
    { timezone: tz }
  );
  console.log(`[cron] activo: "${expr}" (${tz}) -> genera el lote de mañana`);
  return task;
}

module.exports = { startCron, tomorrowStr };
