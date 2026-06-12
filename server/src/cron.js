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

// `job()` es la pasada de generación CATCH-UP (idempotente): asegura el arte
// del álbum del mes (y el siguiente cuando se acerca), la única de hoy y la de
// mañana, y avanza las variantes. Corre CADA HORA: si una pasada se quedó
// corta por cuota, la siguiente retoma — el déficit se drena solo.
function startCron(job) {
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
  const expr = process.env.CRON_GENERATE || "7 * * * *"; // cada hora (min 7: fuera de picos)
  const tz = process.env.CRON_TZ || "UTC";
  if (!cron.validate(expr)) {
    console.warn(`[cron] expresión inválida "${expr}", cron desactivado`);
    return null;
  }
  // Mutex en proceso: si una pasada aún corre (lote grande + cuota lenta), la
  // siguiente se salta en vez de duplicar llamadas a la API en paralelo.
  let running = false;
  const task = cron.schedule(
    expr,
    async () => {
      if (running) { console.log("[cron] pasada anterior aún en curso, salto"); return; }
      running = true;
      try {
        console.log("[cron] pasada de generación (catch-up)...");
        await job();
      } catch (e) {
        console.error("[cron] error en la pasada:", e.message);
      } finally {
        running = false;
      }
    },
    { timezone: tz }
  );
  console.log(`[cron] activo: "${expr}" (${tz}) -> catch-up de álbum/únicas/variantes cada hora`);
  return task;
}

module.exports = { startCron, tomorrowStr };
