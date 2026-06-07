// =============================================================================
// jobs/generateDailyBatch.js — Genera y guarda el lote de aigrons de un día.
//
// Flujo (doc §5 / §6.5):
//   1. Componer el catálogo determinista del día (curva de rareza por id).
//   2. Para cada criatura: pasar por el SEAM de imagen IA (ai/imageProvider):
//        - procedural (defecto): image_url=null, el cliente dibuja desde art_seed.
//        - openai: concepto -> imagen -> filtro de calidad/seguridad -> CDN.
//      Si el filtro la descarta (null), se omite (margen de descartes).
//   3. Validar stats con clamp duro a los rangos de la rareza.
//   4. Insertar la plantilla (con image_url/quality_score) y registrar métricas.
//
// La forma de la fila en BD no cambia entre modos, así que el resto del backend
// y el cliente siguen igual. Lánzalo de noche con cron para batch_date = mañana.
// =============================================================================
require("dotenv").config();
const db = require("../db");
const { dailyBatch } = require("../generator");
const { getImageProvider, clampStats } = require("../ai/imageProvider");

// Construye el "concepto" que consume el proveedor de imagen a partir de la
// plantilla determinista (en modo openai esto alimenta el prompt de imagen).
function conceptFromTemplate(t) {
  return {
    name: t.name,
    species_tags: t.tags,
    visual_description: `a ${t.tags[0]} fused with ${t.tags[1]}, ${t.type.toLowerCase()} elemental creature`,
    lore: t.lore,
    palette: t.type.toLowerCase(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Genera arte con reintentos ante límites de cuota (capa gratuita de Gemini).
async function generateArt(provider, t) {
  for (let tries = 1; tries <= 3; tries++) {
    try {
      return await provider.generate(conceptFromTemplate(t), { rarity: t.rarity, seed: t.art_seed, templateId: t.id });
    } catch (e) {
      if (/429|quota|rate|RESOURCE_EXHAUSTED/i.test(e.message) && tries < 3) {
        console.warn(`[batch] ${t.id}: límite de cuota, espero 20s…`);
        await sleep(20000); continue;
      }
      console.warn(`[batch] error generando arte de ${t.id}: ${e.message}`);
      return null;
    }
  }
  return null;
}

async function generateDailyBatch(date, n) {
  const list = dailyBatch(date, n);
  const provider = getImageProvider();
  // Espaciado entre llamadas para respetar rate limits (configurable). El modo
  // procedural no llama a ninguna API, así que no necesita delay.
  const delayMs = provider.name === "procedural" ? 0 : parseInt(process.env.GEN_DELAY_MS || "2500", 10);
  let inserted = 0;
  let rejected = 0;
  const dist = {};

  for (const t of list) {
    const art = await generateArt(provider, t);
    if (delayMs) await sleep(delayMs);
    if (!art) { rejected++; continue; } // descartada por el filtro de calidad

    const s = clampStats(t.base_stats, t.rarity);

    const r = await db.query(
      `INSERT INTO creature_templates
         (template_id, batch_date, name, species_tags, type, rarity,
          base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s,
          ability_id, lore, image_url, image_thumb_url, art_seed, quality_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (template_id) DO NOTHING`,
      [
        t.id, date, t.name, t.tags, t.type, t.rarity,
        s.hp, s.atkP, s.defP, s.spd,  // base_atk/base_def (legacy) = físico, para compatibilidad
        s.atkP, s.atkS, s.defP, s.defS,
        t.ability, t.lore,
        art.image_url, art.image_thumb_url, t.art_seed, art.quality_score,
      ]
    );
    inserted += r.rowCount;
    dist[t.rarity] = (dist[t.rarity] || 0) + 1;
  }

  const accepted = list.length - rejected;
  const acceptRate = list.length ? Math.round((accepted / list.length) * 100) : 0;
  console.log(
    `[batch ${date}] proveedor=${provider.name} generadas ${list.length}, ` +
    `aceptadas ${accepted} (${acceptRate}%), insertadas ${inserted}, descartadas ${rejected}. Rareza:`,
    dist
  );
  return { date, total: list.length, accepted, inserted, rejected, acceptRate, dist };
}

module.exports = { generateDailyBatch };
