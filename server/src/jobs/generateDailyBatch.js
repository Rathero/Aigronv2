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
const E = require("../generator"); // motor compartido (genTemplate, TYPES, hashStr)
const { getImageProvider } = require("../ai/imageProvider");

// ----------------------------- EVENTOS TEMÁTICOS -----------------------------
// El evento temático del día vive ahora en el MOTOR (E.dailyEvent), fuente única
// para cliente y servidor. Se re-exporta como eventFor por compatibilidad.
const eventFor = E.dailyEvent;

// Composición por CUPOS: escanea candidatos deterministas (date_0000..) y los
// selecciona hasta clavar la curva de rareza exacta (60/25/12/3, ver README §6)
// y el sesgo del evento. Cada plantilla sigue derivando solo de su id, así que
// la paridad cliente/servidor se mantiene (el lote es la selección de ids).
function composeBatch(date, n) {
  const ev = eventFor(date);
  const want = {
    LEGENDARIA: Math.max(1, Math.round(n * 0.03)) + (ev && ev.kind === "legendary" ? (ev.min - 1) : 0),
    EPICA: Math.max(1, Math.round(n * 0.12)),
    RARA: Math.max(1, Math.round(n * 0.25)),
  };
  want.COMUN = Math.max(0, n - want.LEGENDARIA - want.EPICA - want.RARA);
  const out = [];
  const picked = { COMUN: 0, RARA: 0, EPICA: 0, LEGENDARIA: 0 };
  const typeTarget = ev && ev.kind === "type" ? Math.floor(n * ev.share) : 0;
  let typed = 0;
  const passes = typeTarget > 0 ? [true, false] : [false]; // 1º candidatos del tipo del evento
  for (const onlyEventType of passes) {
    for (let i = 0; i < n * 14 && out.length < n; i++) {
      const id = date + "_" + String(i).padStart(4, "0");
      if (out.some((t) => t.id === id)) continue;
      const t = E.genTemplate(id);
      if (picked[t.rarity] >= want[t.rarity]) continue;
      const isEvType = ev && ev.kind === "type" && (t.types || [t.type]).includes(ev.type);
      if (onlyEventType && (!isEvType || typed >= typeTarget)) continue;
      out.push(t);
      picked[t.rarity]++;
      if (isEvType) typed++;
    }
  }
  return out;
}

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
      return await provider.generate(conceptFromTemplate(t), { rarity: t.rarity, seed: t.art_seed, templateId: t.id, transparent: true });
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
  const list = composeBatch(date, n);
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

    // Stats DIRECTAS de genTemplate: ya incluyen el arquetipo por tipo (applyTypeBias),
    // que sale del rango base de rareza a propósito. NO usar clampStats aquí (recortaría
    // el arquetipo). clampStats es solo para stats propuestas por un LLM no fiable.
    const s = t.base_stats;

    const r = await db.query(
      `INSERT INTO creature_templates
         (template_id, batch_date, name, species_tags, type, type2, rarity,
          base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s,
          ability_id, lore, image_url, image_thumb_url, art_seed, quality_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (template_id) DO NOTHING`,
      [
        t.id, date, t.name, t.tags, t.type, (t.types && t.types[1]) || null, t.rarity,
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

// Inserta UNA plantilla (sin/ con arte). batchDate=clave de temporada (mes) para
// el álbum, o la fecha del día para la criatura única. art=null -> el cliente
// dibuja el sprite procedural desde art_seed (el arte IA puede rellenarse luego).
async function insertTemplate(t, batchDate, kind, art) {
  const s = t.base_stats;
  const r = await db.query(
    `INSERT INTO creature_templates
       (template_id, batch_date, kind, name, species_tags, type, type2, rarity,
        base_hp, base_atk, base_def, base_spd, base_atk_p, base_atk_s, base_def_p, base_def_s,
        ability_id, lore, image_url, image_thumb_url, art_seed, quality_score)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     ON CONFLICT (template_id) DO NOTHING`,
    [
      t.id, batchDate, kind, t.name, t.tags, t.type, (t.types && t.types[1]) || null, t.rarity,
      s.hp, s.atkP, s.defP, s.spd,
      s.atkP, s.atkS, s.defP, s.defS,
      t.ability, t.lore,
      art ? art.image_url : null, art ? art.image_thumb_url : null, t.art_seed, art ? art.quality_score : null,
    ]
  );
  return r.rowCount;
}

// Genera (o completa) el ÁLBUM mensual de una temporada. Las plantillas son
// deterministas: se insertan al instante SIN arte (image_url=null) para no
// bloquear; con opts.withArt (cron/admin) se genera el arte IA además.
async function generateSeason(sKey, n, opts = {}) {
  const list = E.composeSeason(sKey, n);
  const provider = getImageProvider();
  const withArt = opts.withArt && provider.name !== "procedural";
  const delayMs = withArt ? parseInt(process.env.GEN_DELAY_MS || "2500", 10) : 0;
  let inserted = 0, withImage = 0;
  const dist = {};
  for (const t of list) {
    let art = null;
    if (withArt) {
      // Solo genera arte si la fila no lo tiene ya (idempotente / reanudable).
      const ex = await db.query("SELECT image_url FROM creature_templates WHERE template_id=$1", [t.id]);
      if (!ex.rowCount || !ex.rows[0].image_url) { art = await generateArt(provider, t); if (delayMs) await sleep(delayMs); }
    }
    inserted += await insertTemplate(t, sKey, "season", art);
    if (art) {
      withImage++;
      await db.query("UPDATE creature_templates SET image_url=$2, image_thumb_url=$3, quality_score=$4 WHERE template_id=$1 AND image_url IS NULL",
        [t.id, art.image_url, art.image_thumb_url, art.quality_score]);
    }
    dist[t.rarity] = (dist[t.rarity] || 0) + 1;
  }
  console.log(`[season ${sKey}] proveedor=${provider.name} álbum=${list.length}, insertadas ${inserted}, con arte ${withImage}. Rareza:`, dist);
  return { season: sKey, total: list.length, inserted, withImage, dist };
}

// La criatura ÚNICA del día (pieza exclusiva/FOMO): una sola plantilla con su
// propio arte. batch_date = el día (kind='unique'), separada del álbum mensual.
async function generateDailyUnique(date, opts = {}) {
  const t = E.dailyUnique(date);
  const provider = getImageProvider();
  let art = null;
  if (opts.withArt !== false && provider.name !== "procedural") {
    const ex = await db.query("SELECT image_url FROM creature_templates WHERE template_id=$1", [t.id]);
    if (!ex.rowCount || !ex.rows[0].image_url) art = await generateArt(provider, t);
  }
  const inserted = await insertTemplate(t, date, "unique", art);
  if (art) await db.query("UPDATE creature_templates SET image_url=$2, image_thumb_url=$3, quality_score=$4 WHERE template_id=$1 AND image_url IS NULL",
    [t.id, art.image_url, art.image_thumb_url, art.quality_score]);
  return { date, id: t.id, inserted, withImage: art ? 1 : 0 };
}

module.exports = { generateDailyBatch, eventFor, composeBatch, generateSeason, generateDailyUnique };
