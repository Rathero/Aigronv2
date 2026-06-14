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
  (await db.query("SELECT template_id AS id, image_url, 'creature_templates' AS tbl FROM creature_templates WHERE image_url IS NOT NULL")).rows.forEach((r) => rows.push(r));
  (await db.query("SELECT id, image_url, 'world_boss' AS tbl FROM world_boss WHERE image_url IS NOT NULL")).rows.forEach((r) => rows.push(r));

  const storage = require("./ai/storage");
  const out = { total: rows.length, done: 0, alreadyTransparent: 0, notProcessable: 0, missing: 0, failed: 0, dryRun: dry };
  for (const r of rows) {
    // Origen del arte: /art local (volumen) o almacén externo S3 (clave del bucket).
    const m = /^\/art\/(.+)$/.exec(r.image_url || "");
    const s3key = !m && storage.enabled() ? storage.keyFromUrl(r.image_url) : null;
    if (!m && !s3key) { out.notProcessable++; continue; } // externas desconocidas (CDN/data-uri)
    const isJpg = (r.image_url || "").endsWith(".jpg");
    if (!isJpg && !(r.image_url || "").endsWith(".png")) { out.notProcessable++; continue; }
    const file = m ? path.join(ART_DIR, m[1]) : null;
    if (file && !fs.existsSync(file)) { out.missing++; continue; }
    try {
      let buf = file ? fs.readFileSync(file) : await storage.getBuffer(s3key);
      // JPEG (sin canal alfa): Gemini a veces lo devuelve y el croma se saltaba,
      // dejando el fondo verde horneado. Se convierte a PNG, se recorta y se
      // guarda COMO .png nuevo, reapuntando la fila de BD.
      let saveAsPng = false;
      if (isJpg) {
        if (!tr.canConvertJpeg()) { out.notProcessable++; continue; }
        buf = tr.jpegToPng(buf);
        saveAsPng = true; // JPG no tiene alfa: siempre re-recortamos a PNG transparente
      }
      // Recorte UNIVERSAL: si el BORDE sigue opaco (fondo de color sin quitar —
      // verde, morado, azul, degradado…) se reprocesa con crecimiento de región
      // AUNQUE ya tenga algo de alfa parcial. Solo se considera "ya hecho" cuando
      // el borde está mayoritariamente transparente.
      let res;
      if (tr.borderOpaqueFrac(buf) < 0.35) {
        out.alreadyTransparent++; continue;
      } else {
        res = tr.keyBackground(buf, tolerance);
        if (res === buf) res = tr.keyEdgesAdaptive(buf, tolerance); // fallback: fondo oscuro contiguo
      }
      if (res === buf && !saveAsPng) { out.failed++; continue; } // descartado por la salvaguarda
      if (!dry) {
        if (saveAsPng) {
          const newUrl = r.image_url.replace(/\.jpg$/, ".png");
          if (file) fs.writeFileSync(file.replace(/\.jpg$/, ".png"), res);
          else await storage.put(s3key.replace(/\.jpg$/, ".png"), res, "image/png");
          const idCol = r.tbl === "world_boss" ? "id" : "template_id";
          await db.query(`UPDATE ${r.tbl} SET image_url=$2 WHERE ${idCol}=$1`, [r.id, newUrl]);
          if (r.tbl === "creature_templates") {
            await db.query("UPDATE creature_templates SET image_thumb_url=$2 WHERE template_id=$1 AND image_thumb_url=$3", [r.id, newUrl, r.image_url]);
          }
        } else if (file) {
          // .bak solo en local; en S3 el reproceso es idempotente y el espacio cuesta.
          if (!fs.existsSync(file + ".bak")) fs.copyFileSync(file, file + ".bak");
          fs.writeFileSync(file, res);
        } else {
          await storage.put(s3key, res, "image/png");
        }
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

// ------------------------- uso y limpieza del volumen ------------------------
// El arte vive en un VOLUMEN limitado (Railway): estas tareas permiten ver qué
// lo llena y liberar espacio sin shell en el contenedor.
function walkArt(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) { walkArt(p, out); continue; }
    out.push({ path: p, rel: path.relative(ART_DIR, p), size: st.size });
  }
  return out;
}
const mb = (n) => Math.round(n / 1024 / 1024 * 10) / 10;

// Informe de uso: total, nº de archivos y cuánto ocupan los .bak (copias de
// seguridad de remove-art-backgrounds: duplican el espacio en silencio).
async function artUsage() {
  if (!fs.existsSync(ART_DIR)) return { totalMB: 0, files: 0 };
  const files = walkArt(ART_DIR, []);
  const total = files.reduce((a, f) => a + f.size, 0);
  const baks = files.filter((f) => f.rel.endsWith(".bak"));
  // Huérfanos: PNG/JPG de criaturas que ya no referencia ninguna fila (lotes
  // diarios viejos purgados, descartes...). ui/ y .bak quedan fuera del cálculo.
  const used = new Set();
  (await db.query("SELECT image_url FROM creature_templates WHERE image_url IS NOT NULL")).rows.forEach((r) => used.add(r.image_url));
  (await db.query("SELECT image_url FROM world_boss WHERE image_url IS NOT NULL")).rows.forEach((r) => used.add(r.image_url));
  const orphans = files.filter((f) => !f.rel.endsWith(".bak") && !f.rel.startsWith("ui/") && !f.rel.startsWith("ui\\") && !used.has("/art/" + f.rel.replace(/\\/g, "/")));
  return {
    totalMB: mb(total), files: files.length,
    bak: { count: baks.length, mb: mb(baks.reduce((a, f) => a + f.size, 0)) },
    orphans: { count: orphans.length, mb: mb(orphans.reduce((a, f) => a + f.size, 0)) },
  };
}

// Limpieza: borra los .bak siempre; con orphans=1 borra también el arte que no
// referencia ninguna fila de BD (conservador: nunca toca ui/ ni lo referenciado).
async function artCleanup(opts = {}) {
  if (!fs.existsSync(ART_DIR)) return { freedMB: 0 };
  const files = walkArt(ART_DIR, []);
  let freed = 0, deleted = 0;
  for (const f of files.filter((x) => x.rel.endsWith(".bak"))) {
    try { fs.unlinkSync(f.path); freed += f.size; deleted++; } catch (e) { /* sigue */ }
  }
  if (opts.orphans) {
    const used = new Set();
    (await db.query("SELECT image_url FROM creature_templates WHERE image_url IS NOT NULL")).rows.forEach((r) => used.add(r.image_url));
    (await db.query("SELECT image_url FROM world_boss WHERE image_url IS NOT NULL")).rows.forEach((r) => used.add(r.image_url));
    for (const f of files) {
      if (f.rel.endsWith(".bak") || f.rel.startsWith("ui/") || f.rel.startsWith("ui\\")) continue;
      if (used.has("/art/" + f.rel.replace(/\\/g, "/"))) continue;
      try { fs.unlinkSync(f.path); freed += f.size; deleted++; } catch (e) { /* sigue */ }
    }
  }
  return { deleted, freedMB: mb(freed), after: await artUsage() };
}

// Migra el arte EXISTENTE del volumen local al almacén externo S3 (R2/B2/GCS):
// sube cada imagen referenciada en BD, actualiza su image_url a la URL pública
// y (con delete=1) borra el archivo local para liberar el volumen. Los assets
// de UI (/art/ui/*) NO se migran: el cliente los referencia por ruta fija.
async function migrateArtToStorage(opts = {}) {
  const storage = require("./ai/storage");
  if (!storage.enabled()) throw new Error("configura ART_S3_ENDPOINT/BUCKET/ACCESS_KEY/SECRET_KEY y ART_PUBLIC_BASE primero");
  const rows = [];
  (await db.query("SELECT template_id AS id, image_url, 'creature_templates' AS tbl FROM creature_templates WHERE image_url LIKE '/art/%'")).rows.forEach((r) => rows.push(r));
  (await db.query("SELECT id, image_url, 'world_boss' AS tbl FROM world_boss WHERE image_url LIKE '/art/%'")).rows.forEach((r) => rows.push(r));
  const out = { total: rows.length, migrated: 0, missing: 0, failed: 0, deletedLocal: 0 };
  for (const r of rows) {
    const rel = r.image_url.slice("/art/".length);
    if (rel.startsWith("ui/")) continue;
    const file = path.join(ART_DIR, rel);
    if (!fs.existsSync(file)) { out.missing++; continue; }
    try {
      const url = await storage.put(rel, fs.readFileSync(file), rel.endsWith(".jpg") ? "image/jpeg" : "image/png");
      if (r.tbl === "world_boss") {
        await db.query("UPDATE world_boss SET image_url=$2 WHERE id=$1", [r.id, url]);
      } else {
        await db.query(
          "UPDATE creature_templates SET image_url=$2, image_thumb_url=CASE WHEN image_thumb_url=$3 THEN $2 ELSE image_thumb_url END WHERE template_id=$1",
          [r.id, url, r.image_url]
        );
      }
      if (opts.delete) { try { fs.unlinkSync(file); out.deletedLocal++; } catch (e) { /* sigue */ } }
      out.migrated++;
    } catch (e) {
      out.failed++;
      if (out.failed <= 3) console.warn(`[art-migrate] ${rel}: ${e.message.slice(0, 120)}`);
    }
  }
  return out;
}

module.exports = { removeArtBackgrounds, generateUiAssets, artUsage, artCleanup, migrateArtToStorage, UI_ASSETS };
