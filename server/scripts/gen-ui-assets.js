// =============================================================================
// scripts/gen-ui-assets.js — CLI de la tarea src/artTasks.js: genera el PACK DE
// ARTE UI (icono, fondos, share, marcos) con el proveedor de imagen configurado.
// Salida: web/art/ui/ (persistente en el volumen de arte en producción).
//
//   node scripts/gen-ui-assets.js              # genera cada asset con su nombre final
//   node scripts/gen-ui-assets.js --variants 4 # genera N variantes (-v1..-vN) para curar
//   node scripts/gen-ui-assets.js icon arena   # solo esos assets
//
// También ejecutable EN REMOTO (Railway) sin shell:
//   curl -X POST -H "x-admin-key: $ADMIN_KEY" "https://tu-app/admin/tasks/gen-ui-assets?variants=3"
//
// Requiere GEMINI_API_KEY (u OPENAI). El juego funciona SIN estos assets
// (fallbacks: gradientes CSS, emoji del jefe, marcos de color plano).
// =============================================================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const { generateUiAssets } = require("../src/artTasks");

(async () => {
  const args = process.argv.slice(2);
  const vIdx = args.indexOf("--variants");
  const variants = vIdx >= 0 ? args[vIdx + 1] : "1";
  const only = args.filter((a, i) => a !== "--variants" && i !== vIdx + 1);
  const out = await generateUiAssets({ variants, only });
  out.generated.forEach((u) => console.log(`✅ ${u}`));
  out.failed.forEach((f) => console.warn(`❌ ${f}`));
  console.log(`\nPack UI: ${out.generated.length} generados, ${out.failed.length} fallidos.`);
  if (out.variants > 1) {
    console.log("Elige tu variante favorita y renómbrala al nombre final, p. ej.:");
    console.log("  cp web/art/ui/icon-512-v2.png web/art/ui/icon-512.png");
  }
  console.log("Los assets se aplican solos al recargar (todos los consumidores tienen fallback).");
})().catch((e) => { console.error("❌ " + e.message); process.exit(1); });
