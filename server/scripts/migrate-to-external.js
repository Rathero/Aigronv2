// scripts/migrate-to-external.js — Copia TODA la base de datos de Railway a un
// Postgres externo (Neon/Supabase/etc.), sin perder nada. Aplica el esquema en el
// destino y copia las filas tabla a tabla en orden de dependencias (FK). Idempotente:
// usa ON CONFLICT DO NOTHING, así que re-ejecutar es seguro.
//
// USO (en la consola de Railway, con DATABASE_URL aún apuntando a Railway):
//   node scripts/migrate-to-external.js "postgresql://USER:PASS@HOST/DB?sslmode=require"
//
// El ORIGEN sale de DATABASE_URL (Railway). El DESTINO es el argumento (Neon).
// IMPORTANTE: ejecuta esto ANTES de cambiar DATABASE_URL. Si ya lo cambiaste,
// el origen sería el destino (vacío) y no copiaría nada.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// Orden de copia: padres antes que hijos (respeta claves foráneas).
const TABLES = [
  "users",
  "creature_templates",
  "creature_instances",
  "teams",
  "battles",
  "daily_scores",
  "battle_offers",
  "daily_missions",
  "fusion_cache",
  "dungeon_runs",
];

const hostOf = (u) => { try { return new URL(u).host; } catch { return "?"; } };

(async () => {
  const targetUrl = process.argv[2] || process.env.TARGET_DATABASE_URL;
  const sourceUrl = process.env.DATABASE_URL;
  if (!targetUrl) { console.error("Falta la URL destino. Uso: node scripts/migrate-to-external.js \"<url-neon>\""); process.exit(1); }
  if (!sourceUrl) { console.error("Falta DATABASE_URL (origen)."); process.exit(1); }
  if (hostOf(targetUrl) === hostOf(sourceUrl)) { console.error("Origen y destino son el MISMO host. Aborto."); process.exit(1); }

  // SSL: requerido por las BD gestionadas (Neon/Supabase exigen sslmode=require);
  // desactivado en local (localhost/127.0.0.1) o si la URL pide sslmode=disable.
  const wantSSL = (url, fallback) => {
    if (/sslmode=disable/i.test(url)) return false;
    if (/sslmode=require/i.test(url)) return true;
    if (/@(localhost|127\.0\.0\.1)[:/]/i.test(url)) return false;
    return fallback;
  };
  const source = new Pool({ connectionString: sourceUrl, ssl: wantSSL(sourceUrl, process.env.PGSSL === "true") ? { rejectUnauthorized: false } : undefined });
  const target = new Pool({ connectionString: targetUrl, ssl: wantSSL(targetUrl, true) ? { rejectUnauthorized: false } : undefined });

  console.log(`ORIGEN : ${hostOf(sourceUrl)}`);
  console.log(`DESTINO: ${hostOf(targetUrl)}\n`);

  // 1. Aplicar el esquema en el destino (idempotente: CREATE TABLE IF NOT EXISTS...).
  const schema = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  console.log("Aplicando esquema en el destino…");
  await target.query(schema);
  console.log("Esquema OK.\n");

  // 2. Copiar tabla a tabla.
  for (const table of TABLES) {
    // Tipos de columna del destino para saber qué serializar como JSON.
    const cols = await target.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1", [table]
    );
    const jsonCols = new Set(cols.rows.filter((c) => c.data_type === "jsonb" || c.data_type === "json").map((c) => c.column_name));

    const src = await source.query(`SELECT * FROM ${table}`);
    if (!src.rowCount) { console.log(`${table.padEnd(20)} 0 filas (vacía)`); continue; }

    const colNames = src.fields.map((f) => f.name);
    const colList = colNames.map((c) => `"${c}"`).join(", ");
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(", ");
    const sql = `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;

    let inserted = 0;
    for (const row of src.rows) {
      const values = colNames.map((c) => {
        const v = row[c];
        // jsonb/json: pg trata los ARRAYS JS como arrays SQL, no como json -> serializar a mano.
        if (jsonCols.has(c) && v !== null && typeof v === "object") return JSON.stringify(v);
        return v;
      });
      const r = await target.query(sql, values);
      inserted += r.rowCount;
    }
    console.log(`${table.padEnd(20)} ${src.rowCount} origen -> ${inserted} insertadas (resto ya existían)`);
  }

  // 3. Verificación: conteos origen vs destino.
  console.log("\nVerificación (origen / destino):");
  for (const table of TABLES) {
    const a = await source.query(`SELECT count(*)::int n FROM ${table}`);
    const b = await target.query(`SELECT count(*)::int n FROM ${table}`);
    const ok = a.rows[0].n === b.rows[0].n ? "OK" : "≠";
    console.log(`  ${table.padEnd(20)} ${a.rows[0].n} / ${b.rows[0].n}  ${ok}`);
  }

  await source.end();
  await target.end();
  console.log("\nMigración terminada. Ahora pon DATABASE_URL = la URL de Neon en Railway y redeploya.");
})();
