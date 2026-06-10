// scripts/repaint-fusions.js — Repinta con IA las fusiones existentes que aún
// tienen sprite procedural (image_url NULL), reconstruyendo la fusión VISUAL a
// partir de los dos padres (recuperados de fusion_cache.pair_key). Actualiza
// image_url EN SITIO (no borra plantillas → las instancias del usuario se conservan).
//
//   node scripts/repaint-fusions.js
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const db = require("./../src/db");
const { getImageProvider, buildImagePrompt } = require("./../src/ai/imageProvider");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function loadRefArt(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/art/")) return null;
  try {
    const buf = fs.readFileSync(path.join(__dirname, "../../web", imageUrl));
    return { mimeType: imageUrl.endsWith(".png") ? "image/png" : "image/jpeg", data: buf.toString("base64") };
  } catch (e) { return null; }
}

(async () => {
  const provider = getImageProvider();
  if (provider.name === "procedural") { console.log("Proveedor = procedural; nada que repintar."); await db.pool.end(); return; }

  const rows = (await db.query(
    `SELECT fc.pair_key, fc.template_id, t.name, t.type, t.rarity, t.species_tags
       FROM fusion_cache fc JOIN creature_templates t ON t.template_id = fc.template_id
      WHERE t.image_url IS NULL`
  )).rows;
  console.log(`[repaint] ${rows.length} fusiones sin arte · proveedor=${provider.name}`);

  let ok = 0, fail = 0;
  for (const f of rows) {
    const m = /^fusion:(.+):(.+)$/.exec(f.pair_key);
    if (!m) { fail++; continue; }
    const pr = (await db.query("SELECT template_id, type, species_tags, image_url FROM creature_templates WHERE template_id = ANY($1)", [[m[1], m[2]]])).rows;
    const pA = pr.find((x) => x.template_id === m[1]) || pr[0];
    const pB = pr.find((x) => x.template_id === m[2]) || pr[1];
    const tagsA = (pA && pA.species_tags) || [f.type.toLowerCase()];
    const tagsB = (pB && pB.species_tags) || [f.type.toLowerCase()];
    const descA = `${tagsA.join(" ")} ${(pA ? pA.type : f.type).toLowerCase()} creature`;
    const descB = `${tagsB.join(" ")} ${(pB ? pB.type : f.type).toLowerCase()} creature`;
    const concept = {
      name: f.name, species_tags: f.species_tags,
      visual_description: `a hybrid creature fusing a ${descA} and a ${descB}, resulting in a ${f.type.toLowerCase()} elemental creature`,
      palette: f.type.toLowerCase(),
    };
    const opts = { rarity: f.rarity, templateId: f.template_id, transparent: true };
    const refs = [pA && loadRefArt(pA.image_url), pB && loadRefArt(pB.image_url)].filter(Boolean);
    if (refs.length === 2) {
      opts.refImages = refs;
      opts.prompt = `Fuse the TWO creatures shown in the reference images into ONE new hybrid that clearly combines features of BOTH — the ${descA} and the ${descB} (mix their body parts, colors and motifs into a single coherent creature). ` + buildImagePrompt(concept, f.rarity, true);
    }
    let art = null;
    try { art = await provider.generate(concept, opts); } catch (e) { console.warn(`  ${f.template_id}: ${e.message}`); }
    if (art && art.image_url) {
      await db.query("UPDATE creature_templates SET image_url=$1, image_thumb_url=$2 WHERE template_id=$3", [art.image_url, art.image_thumb_url, f.template_id]);
      ok++; console.log(`  ✅ ${f.template_id} -> ${art.image_url}${refs.length === 2 ? " (visual)" : ""}`);
    } else { fail++; }
    await sleep(parseInt(process.env.BACKFILL_DELAY_MS || "3000", 10));
  }
  console.log(`[repaint] hecho: ${ok} repintadas, ${fail} sin arte`);
  await db.pool.end();
})();
