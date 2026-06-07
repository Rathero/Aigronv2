// scripts/backfill-art.js — Genera arte IA para las plantillas YA existentes de
// un lote (rellena image_url sin reinsertar, preservando instancias/FKs).
// Útil para "pintar" el lote de hoy sin regenerarlo.
//
//   node scripts/backfill-art.js [fecha] [maxN]
// Respeta el proveedor/modelo del entorno (AI_IMAGE_PROVIDER, GEMINI_IMAGE_MODEL).
// Espacia las llamadas y reintenta en 429 para no pasarse de la cuota gratuita.
require("dotenv").config();
const db = require("../src/db");
const C = require("../src/config");
const { getImageProvider } = require("../src/ai/imageProvider");

const DELAY_MS = parseInt(process.env.BACKFILL_DELAY_MS || "4000", 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const date = process.argv[2] || C.todayStr();
  const maxN = parseInt(process.argv[3] || "999", 10);
  const provider = getImageProvider();
  if (provider.name === "procedural") {
    console.log("Proveedor = procedural (no genera imagen). Configura AI_IMAGE_PROVIDER=gemini|openai.");
    await db.pool.end();
    return;
  }

  const r = await db.query(
    "SELECT template_id,name,species_tags,type,rarity,lore FROM creature_templates WHERE batch_date=$1 AND is_fusion=false AND image_url IS NULL ORDER BY template_id LIMIT $2",
    [date, maxN]
  );
  console.log(`[backfill ${date}] ${r.rowCount} plantillas sin arte · proveedor=${provider.name}`);

  let ok = 0, fail = 0;
  for (const t of r.rows) {
    const tags = t.species_tags && t.species_tags.length ? t.species_tags : [t.type.toLowerCase(), "x"];
    const concept = {
      name: t.name, species_tags: tags,
      visual_description: `a ${tags[0]} fused with ${tags[1]}, ${t.type.toLowerCase()} elemental creature`,
      lore: t.lore, palette: t.type.toLowerCase(),
    };
    let art = null;
    for (let tries = 1; tries <= 3; tries++) {
      try { art = await provider.generate(concept, { rarity: t.rarity, templateId: t.template_id }); break; }
      catch (e) {
        if (/429|quota|rate|RESOURCE_EXHAUSTED/i.test(e.message) && tries < 3) {
          console.log(`  ${t.template_id}: límite de cuota, espero 20s…`);
          await sleep(20000); continue;
        }
        console.warn(`  ${t.template_id}: ${e.message}`); break;
      }
    }
    if (art && art.image_url) {
      await db.query(
        "UPDATE creature_templates SET image_url=$1, image_thumb_url=$2, quality_score=$3 WHERE template_id=$4",
        [art.image_url, art.image_thumb_url, art.quality_score, t.template_id]
      );
      ok++; console.log(`  ✅ ${t.template_id} (${t.type}/${t.rarity}) -> ${art.image_url}`);
    } else { fail++; }
    await sleep(DELAY_MS);
  }
  console.log(`[backfill ${date}] hecho: ${ok} con arte, ${fail} sin (siguen con sprite procedural)`);
  await db.pool.end();
})();
