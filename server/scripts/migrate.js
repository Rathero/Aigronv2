// scripts/migrate.js — aplica db/schema.sql a la base de datos.
// Espera a que la BD esté disponible (reintentos) antes de aplicar el esquema,
// para tolerar arranques en frío en producción (Railway/Render/etc.).
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

async function waitForDb(tries = 15, delayMs = 3000) {
  for (let i = 1; i <= tries; i++) {
    try {
      await db.query("SELECT 1");
      return;
    } catch (e) {
      console.log(`[migrate] esperando a la BD (${i}/${tries}): ${e.message}`);
      if (i === tries) throw e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
  try {
    await waitForDb();
    await db.query(sql);
    console.log("✅ Esquema aplicado correctamente.");
  } catch (e) {
    console.error("❌ Error aplicando el esquema:", e.message);
    if (e.stack) console.error(e.stack);
    console.error("   Revisa DATABASE_URL (en Railway: variable = ${{Postgres.DATABASE_URL}}) y, si tu BD exige SSL, pon PGSSL=true.");
    process.exit(1);
  } finally {
    await db.pool.end();
  }
})();
