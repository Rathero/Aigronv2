// scripts/migrate.js — aplica db/schema.sql y después las migraciones numeradas
// de db/migrations/ (si las hay), registrando cada una en schema_migrations.
//
//   - db/schema.sql: esquema base IDEMPOTENTE (CREATE IF NOT EXISTS / ADD COLUMN
//     IF NOT EXISTS). Se aplica siempre; es seguro re-ejecutarlo.
//   - db/migrations/NNN_descripcion.sql: cambios puntuales que NO son expresables
//     de forma idempotente (backfills costosos, transformaciones de datos...).
//     Se aplican UNA sola vez, en orden, dentro de una transacción cada una.
//
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

async function applyMigrations() {
  const dir = path.join(__dirname, "../db/migrations");
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  if (!files.length) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name       TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  );
  for (const f of files) {
    const done = await db.query("SELECT 1 FROM schema_migrations WHERE name=$1", [f]);
    if (done.rowCount) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      await client.query("COMMIT");
      console.log(`✅ Migración aplicada: ${f}`);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`migración ${f}: ${e.message}`, { cause: e });
    } finally {
      client.release();
    }
  }
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
  try {
    await waitForDb();
    await db.query(sql);
    await applyMigrations();
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
