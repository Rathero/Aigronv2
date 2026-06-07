// scripts/generate-today.js — genera el lote del día (o de la fecha indicada).
// Uso:  node scripts/generate-today.js            (hoy)
//       node scripts/generate-today.js 2026-06-07 (fecha concreta)
//       node scripts/generate-today.js 2026-06-07 150  (fecha + tamaño)
require("dotenv").config();
const db = require("../src/db");
const { todayStr } = require("../src/config");
const { generateDailyBatch } = require("../src/jobs/generateDailyBatch");

(async () => {
  const date = process.argv[2] || todayStr();
  const n = parseInt(process.argv[3] || process.env.DAILY_BATCH_SIZE || "30", 10);
  try {
    await generateDailyBatch(date, n);
  } catch (e) {
    console.error("❌", e.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
})();
