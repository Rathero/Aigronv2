// =============================================================================
// scripts/remove-art-backgrounds.js — Quita el FONDO al arte IA ya generado
// (criaturas, fusiones y jefes con fondo oscuro horneado), dejando PNG con
// transparencia para que floten sobre la UI como los sprites procedurales.
//
//   node scripts/remove-art-backgrounds.js            # procesa todo el arte local
//   node scripts/remove-art-backgrounds.js --dry-run  # solo informa, no escribe
//   node scripts/remove-art-backgrounds.js --tolerance 50
//
// Método: flood-fill desde los bordes con el color de fondo muestreado de las
// esquinas (ai/transparency.keyEdgesAdaptive) — solo elimina la región CONTIGUA
// al exterior, así los oscuros interiores de la criatura quedan protegidos.
// Idempotente: salta imágenes que ya tienen transparencia. Guarda backup .bak
// la primera vez por si quieres revertir alguna.
// =============================================================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const db = require("../src/db");
const tr = require("../src/ai/transparency");

const ART_DIR = path.join(__dirname, "../../web/art");

(async () => {
  if (!tr.available()) {
    console.error("❌ Falta la dependencia opcional 'pngjs' (npm install). Abortando.");
    process.exit(1);
  }
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const tIdx = args.indexOf("--tolerance");
  const tolerance = tIdx >= 0 ? parseInt(args[tIdx + 1] || "42", 10) : 42;

  // Todo el arte referenciado en BD (criaturas + fusiones + jefes).
  const rows = [];
  const tpls = await db.query("SELECT template_id AS id, image_url FROM creature_templates WHERE image_url IS NOT NULL");
  tpls.rows.forEach((r) => rows.push(r));
  const bosses = await db.query("SELECT id, image_url FROM world_boss WHERE image_url IS NOT NULL");
  bosses.rows.forEach((r) => rows.push(r));

  let done = 0, skippedAlpha = 0, skippedExt = 0, missing = 0, failed = 0;
  for (const r of rows) {
    const m = /^\/art\/(.+)$/.exec(r.image_url || "");
    if (!m) { skippedExt++; continue; } // arte externo (CDN): procesar allí
    const file = path.join(ART_DIR, m[1]);
    if (!fs.existsSync(file)) { missing++; continue; }
    if (!file.endsWith(".png")) { skippedExt++; continue; } // jpg sin alfa: regenerar mejor
    try {
      const buf = fs.readFileSync(file);
      if (tr.hasTransparency(buf)) { skippedAlpha++; continue; } // ya procesada
      const out = tr.keyEdgesAdaptive(buf, tolerance);
      if (out === buf) { failed++; console.warn(`⚠️  ${r.id}: el recorte se descartó (¿imagen plana?)`); continue; }
      if (!dry) {
        if (!fs.existsSync(file + ".bak")) fs.copyFileSync(file, file + ".bak");
        fs.writeFileSync(file, out);
      }
      done++;
      if (done % 25 === 0) console.log(`  …${done} procesadas`);
    } catch (e) {
      failed++; console.warn(`❌ ${r.id}: ${e.message}`);
    }
  }
  console.log(`\n${dry ? "[dry-run] " : ""}Fondos eliminados: ${done} · ya transparentes: ${skippedAlpha} · ` +
    `no procesables (jpg/externas): ${skippedExt} · archivos ausentes: ${missing} · fallos: ${failed}`);
  if (done && !dry) console.log("Backups .bak junto a cada PNG (bórralos cuando verifiques el resultado).");
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
