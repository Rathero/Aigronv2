// =============================================================================
// fusion.js — Fusión de dos aigrons en uno nuevo (doc §3.7 / §5.6).
//
// Consume 2 instancias + monedas y produce una criatura nueva cuya rareza es
// probabilística según la rareza de los padres. El resultado es DETERMINISTA por
// par ordenado de template_id (semilla = hash del par), y se CACHEA en
// fusion_cache para no regenerar la misma combinación dos veces.
//
// El ARTE de la fusión se genera ON-DEMAND con el proveedor de imagen configurado
// (IA si AI_IMAGE_PROVIDER=gemini|openai, procedural en otro caso) — única
// excepción al modelo por lotes (doc §5.6). Se genera FUERA de la transacción.
// =============================================================================
const fs = require("fs");
const path = require("path");
const E = require("../../web/engine.js");
const db = require("./db");
const { getImageProvider, buildImagePrompt } = require("./ai/imageProvider");

// Carga el arte local de un padre (web/art) como imagen de referencia para la
// fusión visual. Devuelve {mimeType,data(base64)} o null si no es local/falla.
function loadRefArt(imageUrl) {
  if (!imageUrl || !imageUrl.startsWith("/art/")) return null;
  try {
    const buf = fs.readFileSync(path.join(__dirname, "../../web", imageUrl));
    return { mimeType: imageUrl.endsWith(".png") ? "image/png" : "image/jpeg", data: buf.toString("base64") };
  } catch (e) { return null; }
}

const FUSION_COST = { COMUN: 100, RARA: 200, EPICA: 400, LEGENDARIA: 800 };
const RANK = { COMUN: 0, RARA: 1, EPICA: 2, LEGENDARIA: 3 };

// Decide la rareza resultante con la curva del doc §3.7 (semilla = par).
function resultRarity(rng, majorRarity) {
  const r = rng();
  if (majorRarity === "LEGENDARIA") return r < 0.9 ? "LEGENDARIA" : "EPICA";
  if (majorRarity === "EPICA") return r < 0.15 ? "LEGENDARIA" : r < 0.9 ? "EPICA" : "RARA";
  if (majorRarity === "RARA") return r < 0.25 ? "EPICA" : r < 0.9 ? "RARA" : "COMUN";
  return r < 0.2 ? "RARA" : "COMUN"; // ambos COMUN
}

// Construye (o recupera de caché) la plantilla fusionada de dos plantillas.
// Incluye la generación de arte on-demand con el proveedor de imagen.
async function getOrCreateFusionTemplate(tA, tB) {
  const [loId, hiId] = [tA.template_id, tB.template_id].sort();
  const pairKey = `fusion:${loId}:${hiId}`;

  const cached = await db.query("SELECT template_id FROM fusion_cache WHERE pair_key=$1", [pairKey]);
  if (cached.rowCount) {
    const t = await db.query("SELECT * FROM creature_templates WHERE template_id=$1", [cached.rows[0].template_id]);
    if (t.rowCount) return t.rows[0];
  }

  const seed = E.hashStr(pairKey);
  const rng = E.mulberry32(seed);

  const majorRarity = RANK[tA.rarity] >= RANK[tB.rarity] ? tA.rarity : tB.rarity;
  const rarity = resultRarity(rng, majorRarity);
  const type = rng() < 0.5 ? tA.type : tB.type;
  const ability =
    tA.rarity === tB.rarity ? (rng() < 0.5 ? tA.ability_id : tB.ability_id)
      : RANK[tA.rarity] > RANK[tB.rarity] ? tA.ability_id : tB.ability_id;

  const rg = E.RANGES[rarity];
  const blend = (ka, kb, range) => {
    const avg = (tA[ka] + tB[kb]) / 2;
    const jitter = avg * (0.9 + rng() * 0.2);
    return Math.max(range[0], Math.min(range[1], Math.round(jitter)));
  };
  const base = {
    hp: blend("base_hp", "base_hp", rg.hp), atk: blend("base_atk", "base_atk", rg.atk),
    def: blend("base_def", "base_def", rg.def), spd: blend("base_spd", "base_spd", rg.spd),
  };

  const tagsA = tA.species_tags || [tA.type.toLowerCase(), "x"];
  const tagsB = tB.species_tags || [tB.type.toLowerCase(), "y"];
  const tags = [tagsA[0], tagsB[1] || tagsB[0]];
  const name = E.genName(rng);
  const lore = E.genLore(rng, tags);
  const templateId = "fusion_" + seed.toString(16);

  // Arte on-demand (IA o procedural). No bloquea si falla: cae a sprite procedural.
  // Estrategia de fusión:
  //   - Si AMBOS padres tienen arte -> FUSIÓN VISUAL: se pasan sus imágenes como
  //     referencia (multimodal) + descripción de ambos -> combina sus rasgos reales.
  //   - Si no -> fusión por DESCRIPCIÓN de los dos padres (sus conceptos/tags).
  let art = null;
  try {
    const descA = `${tagsA.join(" ")} ${tA.type.toLowerCase()} creature`;
    const descB = `${tagsB.join(" ")} ${tB.type.toLowerCase()} creature`;
    const concept = {
      name, species_tags: tags,
      visual_description: `a hybrid creature fusing a ${descA} and a ${descB}, resulting in a ${type.toLowerCase()} elemental creature`,
      lore, palette: type.toLowerCase(),
    };
    const opts = { rarity, seed, templateId };
    const refs = [loadRefArt(tA.image_url), loadRefArt(tB.image_url)].filter(Boolean);
    if (refs.length === 2) {
      opts.refImages = refs;
      opts.prompt = `Fuse the TWO creatures shown in the reference images into ONE new hybrid that clearly combines features of BOTH — the ${descA} and the ${descB} (mix their body parts, colors and motifs into a single coherent creature). ` + buildImagePrompt(concept, rarity);
    }
    art = await getImageProvider().generate(concept, opts);
  } catch (e) {
    console.warn(`[fusion] arte falló (${templateId}): ${e.message}`);
  }

  await db.query(
    `INSERT INTO creature_templates
       (template_id, batch_date, name, species_tags, type, rarity,
        base_hp, base_atk, base_def, base_spd, ability_id, lore,
        image_url, image_thumb_url, art_seed, quality_score, is_fusion)
     VALUES ($1, CURRENT_DATE, $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,true)
     ON CONFLICT (template_id) DO NOTHING`,
    [templateId, name, tags, type, rarity, base.hp, base.atk, base.def, base.spd, ability, lore,
     art && art.image_url, art && art.image_thumb_url, seed, art ? art.quality_score : 1.0]
  );
  await db.query(
    "INSERT INTO fusion_cache (pair_key, template_id) VALUES ($1,$2) ON CONFLICT (pair_key) DO NOTHING",
    [pairKey, templateId]
  );
  const t = await db.query("SELECT * FROM creature_templates WHERE template_id=$1", [templateId]);
  return t.rows[0];
}

// Fusiona dos instancias del usuario. El arte se genera FUERA de la transacción;
// la transacción solo valida, consume las instancias, cobra y crea la nueva.
async function fuse(userId, aId, bId) {
  // 1. Validación previa (lectura).
  const q = await db.query(
    `SELECT ci.instance_id, ci.locked, t.*
       FROM creature_instances ci JOIN creature_templates t ON t.template_id = ci.template_id
      WHERE ci.user_id=$1 AND ci.instance_id = ANY($2::uuid[])`,
    [userId, [aId, bId]]
  );
  if (q.rowCount !== 2) throw new Error("not_owned");
  const [ra, rb] = q.rows[0].instance_id === aId ? [q.rows[0], q.rows[1]] : [q.rows[1], q.rows[0]];
  if (ra.locked || rb.locked) throw new Error("locked");
  const inTeam = await db.query(
    "SELECT 1 FROM teams WHERE user_id=$1 AND (slot1=ANY($2::uuid[]) OR slot2=ANY($2::uuid[]) OR slot3=ANY($2::uuid[]))",
    [userId, [aId, bId]]
  );
  if (inTeam.rowCount) throw new Error("in_team");

  const majorRarity = RANK[ra.rarity] >= RANK[rb.rarity] ? ra.rarity : rb.rarity;
  const cost = FUSION_COST[majorRarity];
  const pre = await db.query("SELECT coins FROM users WHERE id=$1", [userId]);
  if (!pre.rowCount || pre.rows[0].coins < cost) throw new Error("insufficient");

  // 2. Plantilla fusionada + arte (puede tardar; fuera de la transacción).
  const tpl = await getOrCreateFusionTemplate(ra, rb);

  // 3. Transacción corta: revalidar, consumir, cobrar, crear instancia.
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    const chk = await client.query("SELECT instance_id, locked FROM creature_instances WHERE user_id=$1 AND instance_id = ANY($2::uuid[]) FOR UPDATE", [userId, [aId, bId]]);
    if (chk.rowCount !== 2) throw new Error("not_owned");
    if (chk.rows.some((r) => r.locked)) throw new Error("locked");
    const team2 = await client.query("SELECT 1 FROM teams WHERE user_id=$1 AND (slot1=ANY($2::uuid[]) OR slot2=ANY($2::uuid[]) OR slot3=ANY($2::uuid[]))", [userId, [aId, bId]]);
    if (team2.rowCount) throw new Error("in_team");
    const u = await client.query("SELECT coins FROM users WHERE id=$1 FOR UPDATE", [userId]);
    if (u.rows[0].coins < cost) throw new Error("insufficient");

    await client.query("DELETE FROM creature_instances WHERE instance_id = ANY($1::uuid[])", [[aId, bId]]);
    await client.query("UPDATE users SET coins=coins-$1 WHERE id=$2", [cost, userId]);
    const ins = await client.query(
      "INSERT INTO creature_instances (user_id, template_id) VALUES ($1,$2) RETURNING instance_id, level",
      [userId, tpl.template_id]
    );
    await client.query("COMMIT");
    return {
      cost,
      instance: {
        instance_id: ins.rows[0].instance_id, level: ins.rows[0].level,
        template: {
          id: tpl.template_id, name: tpl.name, type: tpl.type, rarity: tpl.rarity, ability: tpl.ability_id,
          lore: tpl.lore, art_seed: tpl.art_seed, image_url: tpl.image_url,
          base_stats: { hp: tpl.base_hp, atk: tpl.base_atk, def: tpl.base_def, spd: tpl.base_spd },
        },
      },
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { fuse, resultRarity, getOrCreateFusionTemplate };
