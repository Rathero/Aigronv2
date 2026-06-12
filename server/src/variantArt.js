// =============================================================================
// variantArt.js — Arte IA de VARIANTES, generado de forma PEREZOSA.
//
// Variantes con arte propio (filas "<tplId>__evo1|__evo2|__aurea" en
// creature_templates, kind='variant'):
//   evo1/evo2 — la forma evolucionada (cuando un aigron de un jugador cruza el
//               umbral de nivel por primera vez).
//   aurea     — el shiny dorado (cuando a alguien le sale una áurea de esa
//               plantilla por primera vez).
//
// Perezoso = el coste de imagen se paga solo por variantes que EXISTEN de
// verdad en manos de jugadores, no por todo el álbum × 3. Mientras el arte no
// llega (o el proveedor es procedural), el cliente dibuja el sprite procedural
// derivado (evoArtSeed) o el tinte dorado CSS: nada se rompe sin imagen.
//
// Si hay arte del aigron BASE, se pasa como imagen de referencia (Gemini es
// multimodal): la variante conserva la identidad visual de la criatura.
// =============================================================================
const fs = require("fs");
const path = require("path");
const db = require("./db");
const E = require("./generator");
const { getImageProvider, buildImagePrompt } = require("./ai/imageProvider");

const ART_DIR = path.join(__dirname, "../../web/art");

const VARIANT_NOTE = {
  evo1: " This is the EVOLVED form (stage 2 of 3) of the same creature: noticeably larger and more imposing, extra horns/spikes/ornaments, fiercer pose, more intense glow. Keep the same species, palette and visual identity.",
  evo2: " This is the FINAL evolved form (stage 3 of 3) of the same creature: majestic and powerful, large silhouette, elaborate ornaments, radiant aura, awe-inspiring. Keep the same species, palette and visual identity.",
  aurea: " This is the ultra-rare GOLDEN SHINY variant of the same creature: same species and pose family, but with a luxurious gold/amber palette, holographic golden glow, subtle sparkles. Keep the visual identity recognizable.",
};

// Imagen de referencia (el arte del BASE): mantiene la identidad visual de la
// variante. Soporta /art local y URLs http(s) (almacén externo S3/R2/B2/GCS).
async function refImageFor(baseImageUrl) {
  try {
    const m = /^\/art\/(.+\.png)$/.exec(baseImageUrl || "");
    if (m) return { mimeType: "image/png", data: fs.readFileSync(path.join(ART_DIR, m[1])).toString("base64") };
    if (/^https?:\/\/.+\.png$/.test(baseImageUrl || "")) {
      const storage = require("./ai/storage");
      return { mimeType: "image/png", data: (await storage.getBuffer(baseImageUrl)).toString("base64") };
    }
  } catch (e) { /* sin referencia: se genera solo con el prompt */ }
  return null;
}

// Nombre/stats de la fila de variante (solo informativos: el combate y la
// colección siguen derivando del BASE; esta fila existe para alojar el arte).
function variantRow(base, kind) {
  const stage = kind === "evo1" ? 1 : kind === "evo2" ? 2 : 0;
  return {
    id: E.variantArtId(base.id, kind),
    name: stage ? E.evoName(base.name, base.id, stage) : base.name + " Áurea",
    seed: stage ? E.evoArtSeed(base.id, stage) : base.art_seed,
  };
}

// Garantiza la fila + (si hay proveedor IA) su imagen. Idempotente y segura
// ante concurrencia (INSERT ON CONFLICT + UPDATE solo si image_url IS NULL).
async function ensureVariantArt(base, kind) {
  const v = variantRow(base, kind);
  const s = base.base_stats;
  await db.query(
    `INSERT INTO creature_templates
       (template_id, batch_date, kind, name, species_tags, type, type2, rarity,
        base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s,
        ability_id, lore, art_seed)
     VALUES ($1, CURRENT_DATE, 'variant', $2, $3, $4, $5, $6,
             $7, $8, $9, $10, $11, $12, $13, $14,
             $15, $16, $17)
     ON CONFLICT (template_id) DO NOTHING`,
    [v.id, v.name, base.tags || [], base.type, (base.types && base.types[1]) || null, base.rarity,
      s.hp, s.atkP, s.defP, s.spd,          // base_hp/base_atk/base_def/base_spd (legacy = físico)
      s.atkP, s.atkS, s.defP, s.defS,       // atk/def físico y especial
      base.ability, base.lore || null, v.seed]
  );
  const row = await db.query("SELECT image_url FROM creature_templates WHERE template_id=$1", [v.id]);
  if (row.rows[0] && row.rows[0].image_url) return { id: v.id, image_url: row.rows[0].image_url, generated: false };

  const provider = getImageProvider();
  if (provider.name === "procedural") return { id: v.id, image_url: null, generated: false };

  const tags = (base.tags && base.tags.length >= 2) ? base.tags : ["beast", "spirit"];
  const concept = {
    name: v.name, species_tags: tags,
    visual_description: `a ${tags[0]} fused with ${tags[1]}, ${base.type.toLowerCase()} elemental creature`,
    palette: kind === "aurea" ? "golden amber" : base.type.toLowerCase(),
  };
  const prompt = buildImagePrompt(concept, base.rarity, true) + VARIANT_NOTE[kind];
  const ref = await refImageFor(base.image_url);
  try {
    const art = await provider.generate(concept, {
      prompt, rarity: base.rarity, templateId: v.id, transparent: true,
      refImages: ref ? [ref] : undefined,
    });
    if (art && art.image_url) {
      await db.query(
        "UPDATE creature_templates SET image_url=$2, image_thumb_url=$3, quality_score=$4 WHERE template_id=$1 AND image_url IS NULL",
        [v.id, art.image_url, art.image_thumb_url, art.quality_score]
      );
      return { id: v.id, image_url: art.image_url, generated: true };
    }
  } catch (e) {
    console.warn(`[variant-art] ${v.id}: ${e.message}`);
  }
  return { id: v.id, image_url: null, generated: false };
}

// Versión fire-and-forget para usar en endpoints calientes (level-up, reclamo):
// no bloquea la respuesta; si falla, el cliente sigue con el sprite procedural.
function ensureVariantArtAsync(base, kind) {
  ensureVariantArt(base, kind).catch((e) => console.warn(`[variant-art] async ${kind} ${base.id}: ${e.message}`));
}

// PREGENERACIÓN del álbum completo: el arte de TODAS las variantes posibles de
// la temporada (etapas de evolución según el plan de cada aigron + su áurea),
// con los DESTACADOS de hoy/mañana primero (es de donde salen la mayoría de
// capturas). Idempotente y reanudable: el cron nocturno la ejecuta cada noche
// y avanza hasta agotar `limit` (respeta la cuota del proveedor); en pocas
// noches el álbum entero queda cubierto y nadie ve nunca una variante sin arte.
async function pregenerateSeasonVariants(sKey, opts = {}) {
  const provider = getImageProvider();
  if (provider.name === "procedural") return { skipped: "proveedor procedural (sin coste: el cliente dibuja el sprite)" };
  const { tplBaseStats, tplTypes } = require("./util");
  const rows = await db.query(
    `SELECT template_id, name, type, type2, rarity, ability_id, species_tags, lore, art_seed, image_url,
            base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s
       FROM creature_templates WHERE batch_date=$1 AND kind='season' AND is_fusion=false ORDER BY template_id`,
    [sKey]
  );
  const bases = rows.rows.map((r) => ({ id: r.template_id, name: r.name, type: r.type, types: tplTypes(r),
    rarity: r.rarity, ability: r.ability_id, tags: r.species_tags, lore: r.lore, art_seed: r.art_seed,
    image_url: r.image_url, base_stats: tplBaseStats(r) }));
  // Prioridad: destacados de hoy y de mañana primero, después el resto del álbum.
  const today = E.todayStr();
  const tomorrow = E.todayStr(new Date(Date.now() + 86400000));
  const hi = new Set([
    ...E.dailyHighlights(today, bases, 18).map((t) => t.id),
    ...E.dailyHighlights(tomorrow, bases, 18).map((t) => t.id),
  ]);
  bases.sort((a, b) => (hi.has(b.id) ? 1 : 0) - (hi.has(a.id) ? 1 : 0));

  const limit = parseInt(opts.limit || process.env.VARIANT_PREGEN_LIMIT || "120", 10);
  const delay = parseInt(process.env.GEN_DELAY_MS || "2500", 10);
  const out = { candidates: 0, generated: 0, pending: 0, limit };
  for (const base of bases) {
    const kinds = E.evolutionPlan(base.id).map((e) => "evo" + e.stage).concat(["aurea"]);
    for (const kind of kinds) {
      out.candidates++;
      if (out.generated >= limit) { out.pending++; continue; }
      const r = await ensureVariantArt(base, kind);
      if (r.generated) { out.generated++; await new Promise((res) => setTimeout(res, delay)); }
      else if (!r.image_url) out.pending++;
    }
  }
  return out;
}

// Pregenera las variantes de UNA plantilla (p. ej. la criatura única del día:
// su plan de evolución + su áurea) para que estén listas desde el minuto uno.
async function pregenerateTemplateVariants(base) {
  const kinds = E.evolutionPlan(base.id).map((e) => "evo" + e.stage).concat(["aurea"]);
  const out = { generated: 0 };
  const delay = parseInt(process.env.GEN_DELAY_MS || "2500", 10);
  for (const kind of kinds) {
    const r = await ensureVariantArt(base, kind);
    if (r.generated) { out.generated++; await new Promise((res) => setTimeout(res, delay)); }
  }
  return out;
}

// Backfill (tarea admin): recorre las criaturas de los jugadores y genera el
// arte de variantes que ya existen (evolucionadas por nivel / áureas) sin imagen.
async function backfillVariantArt() {
  const insts = await db.query(
    `SELECT ci.instance_id, ci.level, t.template_id, t.name, t.type, t.type2, t.rarity, t.ability_id,
            t.species_tags, t.lore, t.art_seed, t.image_url,
            t.base_hp, t.base_atk, t.base_def, t.base_spd, t.base_atk_p, t.base_atk_s, t.base_def_p, t.base_def_s
       FROM creature_instances ci JOIN creature_templates t ON t.template_id=ci.template_id
      WHERE t.kind <> 'variant'`
  );
  const { tplBaseStats, tplTypes } = require("./util");
  const todo = new Map(); // artId -> {base, kind}
  for (const r of insts.rows) {
    const base = { id: r.template_id, name: r.name, type: r.type, types: tplTypes(r), rarity: r.rarity,
      ability: r.ability_id, tags: r.species_tags, lore: r.lore, art_seed: r.art_seed, image_url: r.image_url,
      base_stats: tplBaseStats(r) };
    const stage = E.evoStageAt(r.template_id, r.level);
    for (let st = 1; st <= stage; st++) todo.set(E.variantArtId(r.template_id, "evo" + st), { base, kind: "evo" + st });
    if (E.variantOf(r.instance_id) === "aurea") todo.set(E.variantArtId(r.template_id, "aurea"), { base, kind: "aurea" });
  }
  const out = { candidates: todo.size, generated: 0, pending: 0 };
  const delay = parseInt(process.env.GEN_DELAY_MS || "2500", 10);
  for (const { base, kind } of todo.values()) {
    const r = await ensureVariantArt(base, kind);
    if (r.generated) { out.generated++; await new Promise((res) => setTimeout(res, delay)); }
    else if (!r.image_url) out.pending++;
  }
  return out;
}

module.exports = { ensureVariantArt, ensureVariantArtAsync, backfillVariantArt, pregenerateSeasonVariants, pregenerateTemplateVariants };
