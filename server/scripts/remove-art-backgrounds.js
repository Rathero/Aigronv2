// =============================================================================
// scripts/remove-art-backgrounds.js — CLI de la tarea src/artTasks.js: quita el
// FONDO al arte IA ya generado (idempotente, deja .bak la primera vez).
//
//   node scripts/remove-art-backgrounds.js            # procesa todo el arte local
//   node scripts/remove-art-backgrounds.js --dry-run  # solo informa, no escribe
//   node scripts/remove-art-backgrounds.js --tolerance 50
//
// También ejecutable EN REMOTO (Railway) sin shell:
//   curl -X POST -H "x-admin-key: $ADMIN_KEY" https://tu-app/admin/tasks/remove-art-backgrounds
// =============================================================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const db = require("../src/db");
const { removeArtBackgrounds } = require("../src/artTasks");

(async () => {
  const args = process.argv.slice(2);
  const tIdx = args.indexOf("--tolerance");
  const out = await removeArtBackgrounds({
    dryRun: args.includes("--dry-run"),
    tolerance: tIdx >= 0 ? args[tIdx + 1] : undefined,
  });
  console.log(`${out.dryRun ? "[dry-run] " : ""}Fondos eliminados: ${out.done} · ya transparentes: ${out.alreadyTransparent} · ` +
    `no procesables (jpg/externas): ${out.notProcessable} · archivos ausentes: ${out.missing} · fallos: ${out.failed}`);
  if (out.done && !out.dryRun) console.log("Backups .bak junto a cada PNG (bórralos cuando verifiques el resultado).");
  await db.pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
