// =============================================================================
// artTasks.js — Tareas de arte ejecutables EN el servidor (Railway): las usan
// los scripts CLI y los endpoints /admin/tasks/* (el volumen de arte y la
// GEMINI_API_KEY viven en el contenedor, así que deben correr allí).
//
//   removeArtBackgrounds({dryRun, tolerance}) — quita el fondo al arte ya
//     generado (criaturas+fusiones+jefes) con recorte adaptativo. Idempotente.
//   generateUiAssets({variants, only})        — genera el pack de arte UI
//     (icono, fondos, share, marcos) con el proveedor de imagen configurado.
// =============================================================================
const fs = require("fs");
const path = require("path");
const db = require("./db");
const tr = require("./ai/transparency");
const { getImageProvider } = require("./ai/imageProvider");

const ART_DIR = path.join(__dirname, "../../web/art");

// ---------------- quitar fondo al arte existente (idempotente) ---------------
async function removeArtBackgrounds(opts = {}) {
  if (!tr.available()) throw new Error("falta la dependencia opcional 'pngjs'");
  const dry = !!opts.dryRun;
  const tolerance = parseInt(opts.tolerance || "42", 10);

  const rows = [];
  (await db.query("SELECT template_id AS id, image_url FROM creature_templates WHERE image_url IS NOT NULL")).rows.forEach((r) => rows.push(r));
  (await db.query("SELECT id, image_url FROM world_boss WHERE image_url IS NOT NULL")).rows.forEach((r) => rows.push(r));

  const out = { total: rows.length, done: 0, alreadyTransparent: 0, notProcessable: 0, missing: 0, failed: 0, dryRun: dry };
  for (const r of rows) {
    const m = /^\/art\/(.+)$/.exec(r.image_url || "");
    if (!m) { out.notProcessable++; continue; } // externas (CDN/data-uri)
    const file = path.join(ART_DIR, m[1]);
    if (!fs.existsSync(file)) { out.missing++; continue; }
    if (!file.endsWith(".png")) { out.notProcessable++; continue; } // jpg: regenerar mejor
    try {
      const buf = fs.readFileSync(file);
      // Fondo VERDE croma: re-procesa con el flood-fill AUNQUE ya tenga algo de
      // alfa (el croma por umbral antiguo dejaba el verde a medio quitar y el
      // chequeo de "ya transparente" lo saltaba — esa era la causa del bug).
      let res;
      if (tr.hasGreenBg(buf)) {
        res = tr.chromaKeyGreen(buf);
      } else if (tr.hasTransparency(buf)) {
        out.alreadyTransparent++; continue;
      } else {
        res = tr.keyEdgesAdaptive(buf, tolerance); // fondo oscuro antiguo
      }
      if (res === buf) { out.failed++; continue; } // descartado por la salvaguarda
      if (!dry) {
        if (!fs.existsSync(file + ".bak")) fs.copyFileSync(file, file + ".bak");
        fs.writeFileSync(file, res);
      }
      out.done++;
    } catch (e) { out.failed++; }
  }
  return out;
}

// ----------------------------- pack de arte UI -------------------------------
// Lenguaje visual FIJO del juego (la consistencia separa "pulido" de "collage").
const STYLE =
  "16-bit pixel art, retro video game asset. Dark near-black background (#0a0818). " +
  "Neon palette: cyan #34f5e4, magenta #ff4d9d, gold #ffd23f, deep purple #3a3270. " +
  "Crisp visible square pixels, limited palette, clean pixel edges, subtle scanlines feel. " +
  "No text, no watermark, no humans, no UI elements, no photographic textures.";

const UI_ASSETS = [
  { key: "icon", file: "icon-512", aspect: "1:1",
    prompt: `App icon: a single cute collectible pixel-art monster mascot (round body, big expressive eyes, tiny horns), centered, bold readable silhouette, vivid cyan body with magenta accents, soft neon glow, dark background filling the whole square. ${STYLE}` },
  { key: "arena", file: "arena-bg", aspect: "16:9",
    prompt: `Battle arena background for a creature-fighting game: empty dark futuristic coliseum floor seen slightly from above, faint neon floor lines (cyan and magenta), distant glowing pillars, lots of empty dark space in the middle (sprites will be drawn on top), very low contrast and DIM so foreground characters stay readable. ${STYLE}` },
  { key: "boss", file: "boss-bg", aspect: "16:9",
    prompt: `World-boss lair background: ominous dark cavern with cracked neon-magenta crystals and faint golden embers, oppressive atmosphere, empty dark center, very dim and low contrast (a huge boss sprite will be shown on top). ${STYLE}` },
  { key: "share", file: "share-bg", aspect: "3:4",
    prompt: `Trading-card background template: elegant dark vertical card with a thin ornate neon-cyan pixel border near the edges, subtle radial glow in the upper half (a creature sprite goes there), empty lower third (text goes there), starfield specks. ${STYLE}` },
  { key: "frame-plata", file: "frame-plata", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: silver/steel pixel filigree border with subtle pale glow, corner ornaments, border thickness about 8% of the image. Center must be plain dark (#0a0818), all decoration on the border ring. ${STYLE}` },
  { key: "frame-oro", file: "frame-oro", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: golden pixel filigree border with warm glow and small gems in the corners, border thickness about 8% of the image. Center plain dark (#0a0818), all decoration on the border ring. ${STYLE}` },
  { key: "frame-diamante", file: "frame-diamante", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: diamond/ice crystal pixel border, pale cyan glow, faceted corner crystals, border thickness about 8% of the image. Center plain dark (#0a0818). ${STYLE}` },
  { key: "frame-campeon", file: "frame-campeon", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: champion's border mixing magenta neon and gold laurel motifs, tiny crown at top center of the border, border thickness about 8% of the image. Center plain dark (#0a0818). ${STYLE}` },
];

async function generateUiAssets(opts = {}) {
  const provider = getImageProvider();
  if (provider.name === "procedural") {
    throw new Error("proveedor 'procedural': configura GEMINI_API_KEY (u OPENAI_API_KEY) para generar el pack");
  }
  const variants = Math.max(1, parseInt(opts.variants || "1", 10));
  const only = (opts.only || []).filter(Boolean);
  fs.mkdirSync(path.join(ART_DIR, "ui"), { recursive: true });

  const list = UI_ASSETS.filter((a) => !only.length || only.includes(a.key));
  const out = { generated: [], failed: [], variants };
  const delay = parseInt(process.env.GEN_DELAY_MS || "2500", 10);
  for (const a of list) {
    for (let v = 1; v <= variants; v++) {
      const name = variants > 1 ? `${a.file}-v${v}` : a.file;
      process.env.GEMINI_ASPECT = a.aspect; // el proveedor lo lee por llamada
      try {
        const r = await provider.generate({}, { prompt: a.prompt, rarity: "COMUN", templateId: "ui/" + name });
        if (r && r.image_url) out.generated.push(r.image_url);
        else out.failed.push(name + " (filtro)");
      } catch (e) {
        out.failed.push(`${name}: ${e.message.slice(0, 80)}`);
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return out;
}

module.exports = { removeArtBackgrounds, generateUiAssets, UI_ASSETS };
