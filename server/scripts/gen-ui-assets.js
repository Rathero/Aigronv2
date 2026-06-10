// =============================================================================
// scripts/gen-ui-assets.js — Genera el PACK DE ARTE UI con el seam de imagen
// (Gemini/OpenAI). Estilo unificado con la paleta del juego. Salida: web/art/ui/
// (servido en /art/ui/, persistente en el volumen de arte en producción).
//
//   node scripts/gen-ui-assets.js              # genera cada asset con su nombre final
//   node scripts/gen-ui-assets.js --variants 4 # genera N variantes (-v1..-vN) para curar
//   node scripts/gen-ui-assets.js icon arena   # solo esos assets
//
// Requiere GEMINI_API_KEY (u OPENAI). Con proveedor procedural no hace nada:
// el juego entero funciona SIN estos assets (todos los consumidores tienen
// fallback: gradientes CSS, emoji del jefe, marcos de color plano).
// =============================================================================
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const { getImageProvider } = require("../src/ai/imageProvider");

// Lenguaje visual FIJO del juego (la consistencia es lo que separa "pulido" de
// "collage"): pixel-art 16-bit, neón cian/magenta/dorado sobre casi-negro.
const STYLE =
  "16-bit pixel art, retro video game asset. Dark near-black background (#0a0818). " +
  "Neon palette: cyan #34f5e4, magenta #ff4d9d, gold #ffd23f, deep purple #3a3270. " +
  "Crisp visible square pixels, limited palette, clean pixel edges, subtle scanlines feel. " +
  "No text, no watermark, no humans, no UI elements, no photographic textures.";

const ASSETS = [
  {
    key: "icon", file: "icon-512", aspect: "1:1",
    prompt: `App icon: a single cute collectible pixel-art monster mascot (round body, big expressive eyes, tiny horns), centered, bold readable silhouette, vivid cyan body with magenta accents, soft neon glow, dark background filling the whole square. ${STYLE}`,
  },
  {
    key: "arena", file: "arena-bg", aspect: "16:9",
    prompt: `Battle arena background for a creature-fighting game: empty dark futuristic coliseum floor seen slightly from above, faint neon floor lines (cyan and magenta), distant glowing pillars, lots of empty dark space in the middle (sprites will be drawn on top), very low contrast and DIM so foreground characters stay readable. ${STYLE}`,
  },
  {
    key: "boss", file: "boss-bg", aspect: "16:9",
    prompt: `World-boss lair background: ominous dark cavern with cracked neon-magenta crystals and faint golden embers, oppressive atmosphere, empty dark center, very dim and low contrast (a huge boss sprite will be shown on top). ${STYLE}`,
  },
  {
    key: "share", file: "share-bg", aspect: "3:4",
    prompt: `Trading-card background template: elegant dark vertical card with a thin ornate neon-cyan pixel border near the edges, subtle radial glow in the upper half (a creature sprite goes there), empty lower third (text goes there), starfield specks. ${STYLE}`,
  },
  {
    key: "frame-plata", file: "frame-plata", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow transparent-looking dark center) for a collectible card: silver/steel pixel filigree border with subtle pale glow, corner ornaments, border thickness about 8% of the image. Center must be plain dark (#0a0818), all decoration on the border ring. ${STYLE}`,
  },
  {
    key: "frame-oro", file: "frame-oro", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: golden pixel filigree border with warm glow and small gems in the corners, border thickness about 8% of the image. Center plain dark (#0a0818), all decoration on the border ring. ${STYLE}`,
  },
  {
    key: "frame-diamante", file: "frame-diamante", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: diamond/ice crystal pixel border, pale cyan glow, faceted corner crystals, border thickness about 8% of the image. Center plain dark (#0a0818). ${STYLE}`,
  },
  {
    key: "frame-campeon", file: "frame-campeon", aspect: "1:1",
    prompt: `Ornate square FRAME (border only, hollow dark center) for a collectible card: champion's border mixing magenta neon and gold laurel motifs, tiny crown at top center of the border, border thickness about 8% of the image. Center plain dark (#0a0818). ${STYLE}`,
  },
];

(async () => {
  const args = process.argv.slice(2);
  const vIdx = args.indexOf("--variants");
  const variants = vIdx >= 0 ? Math.max(1, parseInt(args[vIdx + 1] || "1", 10)) : 1;
  const only = args.filter((a, i) => a !== "--variants" && i !== vIdx + 1);

  const provider = getImageProvider();
  if (provider.name === "procedural") {
    console.error("❌ Proveedor 'procedural': define GEMINI_API_KEY (u OPENAI_API_KEY) para generar el pack.");
    console.error("   El juego funciona sin estos assets; este script solo añade el pulido visual.");
    process.exit(1);
  }
  fs.mkdirSync(path.join(__dirname, "../../web/art/ui"), { recursive: true });

  const list = ASSETS.filter((a) => !only.length || only.includes(a.key));
  let ok = 0, fail = 0;
  for (const a of list) {
    for (let v = 1; v <= variants; v++) {
      const name = variants > 1 ? `${a.file}-v${v}` : a.file;
      process.env.GEMINI_ASPECT = a.aspect; // el proveedor lo lee por llamada
      try {
        const r = await provider.generate({}, { prompt: a.prompt, rarity: "COMUN", templateId: "ui/" + name });
        if (r && r.image_url) { console.log(`✅ ${name} -> ${r.image_url}`); ok++; }
        else { console.warn(`⚠️  ${name}: descartado por el filtro`); fail++; }
      } catch (e) {
        console.error(`❌ ${name}: ${e.message}`); fail++;
      }
      await new Promise((r) => setTimeout(r, parseInt(process.env.GEN_DELAY_MS || "2500", 10)));
    }
  }
  console.log(`\nPack UI: ${ok} generados, ${fail} fallidos.`);
  if (variants > 1) {
    console.log("Elige tu variante favorita y renómbrala al nombre final, p. ej.:");
    console.log("  cp web/art/ui/icon-512-v2.png web/art/ui/icon-512.png");
  }
  console.log("Los assets se aplican solos al recargar (todos los consumidores tienen fallback).");
})();
