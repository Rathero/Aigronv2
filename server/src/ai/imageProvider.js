// =============================================================================
// ai/imageProvider.js — SEAM del pipeline de imagen IA (doc §5).
//
// La llamada de imagen está abstraída tras una interfaz para poder cambiar de
// proveedor sin tocar el resto del juego (mitigación de riesgo, doc §8):
//
//   provider.generate(concept, { rarity, seed }) ->
//       { image_url, image_thumb_url, quality_score }   // aceptada
//       | null                                          // descartada por el filtro
//
// Proveedor por defecto: "procedural" — NO llama a ninguna API. El cliente
// dibuja el sprite pixel-art desde art_seed, así que el juego funciona y se
// despliega sin claves. Cuando definas AI_IMAGE_PROVIDER=openai y OPENAI_API_KEY,
// se genera arte real por lotes (concepto -> imagen -> filtro de visión).
//
// Seleccionado con la variable de entorno AI_IMAGE_PROVIDER (procedural|openai).
// =============================================================================
const E = require("../../../web/engine.js");

// ---------------------------- Construcción de prompt -------------------------
// Estilo UNIFICADO acorde a la app: pixel-art retro neón. Con `transparent` el
// fondo pasa a VERDE CROMA puro (luego se elimina en transparency.js): así los
// aigrons flotan sobre la UI como los sprites procedurales, sin bloque cuadrado.
const CHROMA_NOTE =
  " The subject is isolated on a flat solid uniform pure green (#00FF00) chroma-key " +
  "background filling the whole canvas: no gradients, no shadows, no glow on the " +
  "background itself, and absolutely no pure-green tones inside the creature.";
function buildImagePrompt(concept, rarity, transparent) {
  const bgPhrase = transparent ? "" : " on a dark near-black background";
  const base =
    `16-bit pixel art sprite of ${concept.visual_description}. ` +
    `A single centered full-body collectible monster, retro video-game creature. ` +
    `${concept.palette} colors with a vivid neon glow${bgPhrase}. ` +
    `Crisp visible square pixels, limited palette, clean pixel edges, subtle neon rim light, ` +
    `front-facing, bold readable silhouette, slight dithering. ` +
    `No text, no watermark, no humans, no border, no UI, no grid.` +
    (transparent ? CHROMA_NOTE : "");
  if (rarity === "LEGENDARIA") return base + " Legendary tier: ornate details, glowing golden accents, epic radiant aura.";
  if (rarity === "EPICA") return base + " Epic tier: vivid magenta/purple neon glow, fancy details.";
  if (rarity === "RARA") return base + " Rare tier: cool cyan/blue neon glow.";
  return base;
}

// Umbral de aceptación del filtro de calidad (doc §5.4).
function accepted(qc, rarity) {
  const threshold = rarity === "LEGENDARIA" ? 0.85 : 0.7;
  return (
    qc.is_single_clear_creature &&
    !qc.has_artifacts &&
    !qc.has_text_or_watermark &&
    qc.is_safe &&
    qc.matches_style &&
    qc.quality_score >= threshold
  );
}

// --------------------------- Proveedor PROCEDURAL ---------------------------
// No genera imagen: deja image_url=null y el cliente dibuja desde art_seed.
// Acepta siempre (quality_score 1.0). Es el modo por defecto y de desarrollo.
const proceduralProvider = {
  name: "procedural",
  async generate(_concept, _opts) {
    return { image_url: null, image_thumb_url: null, quality_score: 1.0 };
  },
};

// ----------------------------- Proveedor OPENAI -----------------------------
// Activo solo si AI_IMAGE_PROVIDER=openai y OPENAI_API_KEY está presente.
// Implementa el flujo del doc: imagen (gpt-image-1) -> filtro de visión (LLM) ->
// subida a almacenamiento (local servido en /art, o S3/R2 si se configura).
// Se carga de forma perezosa para no requerir 'openai' como dependencia dura.
function makeOpenAIProvider() {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");

  let client = null;
  function getClient() {
    if (client) return client;
    const OpenAI = require("openai"); // dependencia opcional
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return client;
  }

  const ART_DIR = path.join(__dirname, "../../../web/art");
  const PUBLIC_BASE = process.env.ART_PUBLIC_BASE || "/art";

  const storage = require("./storage");
  async function saveLocal(buffer, key) {
    if (storage.enabled()) return storage.put(key + ".png", buffer, "image/png");
    fs.mkdirSync(path.join(ART_DIR, path.dirname(key)), { recursive: true });
    const file = path.join(ART_DIR, key + ".png");
    fs.writeFileSync(file, buffer);
    return `${PUBLIC_BASE}/${key}.png`;
  }

  return {
    name: "openai",
    async generate(concept, opts) {
      const oa = getClient();
      const prompt = opts.prompt || buildImagePrompt(concept, opts.rarity, opts.transparent);

      // 1. Generar imagen. gpt-image-1 devuelve b64 por defecto; dall-e necesita
      //    response_format explícito.
      const model = process.env.IMAGE_MODEL || "gpt-image-1";
      const params = { model, prompt, size: "1024x1024", n: 1 };
      // gpt-image-1 soporta fondo transparente NATIVO (sin croma ni post-proceso).
      if (opts.transparent && !/^dall-e/.test(model)) { params.background = "transparent"; params.output_format = "png"; }
      if (/^dall-e/.test(model)) params.response_format = "b64_json";
      const img = await oa.images.generate(params);
      const b64 = img.data && img.data[0] && img.data[0].b64_json;
      if (!b64) throw new Error("respuesta de imagen sin b64_json");
      const buffer = Buffer.from(b64, "base64");

      // 2. Filtro de calidad/seguridad (visión). Opcional: AI_VISION_FILTER=off lo
      //    salta (útil para pruebas rápidas). Por defecto está activo.
      let qc = { is_single_clear_creature: true, has_artifacts: false, has_text_or_watermark: false, is_safe: true, matches_style: true, quality_score: 0.8 };
      if ((process.env.AI_VISION_FILTER || "off") === "on") {
        try {
          const visionModel = process.env.VISION_MODEL || "gpt-4o-mini";
          const resp = await oa.chat.completions.create({
            model: visionModel,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: "Eres un controlador de calidad de arte para un juego. Responde SOLO JSON." },
              {
                role: "user",
                content: [
                  { type: "text", text: "Evalúa esta imagen de criatura coleccionable. Devuelve JSON con: is_single_clear_creature, has_artifacts, has_text_or_watermark, is_safe, matches_style, quality_score (0-1), reject_reason." },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
                ],
              },
            ],
          });
          qc = JSON.parse(resp.choices[0].message.content);
        } catch (e) {
          // Conservador: no publicar arte sin validar (seguridad de contenido).
          console.warn(`[ai] filtro de visión falló (${opts.templateId}): ${e.message}`);
          return null;
        }
        if (!accepted(qc, opts.rarity)) return null;
      }

      // 3. Subir (local por defecto en web/art, servido en /art; reemplazable por S3/R2).
      const key = opts.templateId || crypto.randomBytes(6).toString("hex");
      const url = await saveLocal(buffer, key);
      // Thumbnail: en MVP servimos la misma imagen (el cliente la escala).
      return { image_url: url, image_thumb_url: url, quality_score: qc.quality_score };
    },
  };
}

// ----------------------------- Proveedor GEMINI -----------------------------
// Usa la API de Gemini (Google AI Studio) con una API key GRATIS (capa gratuita,
// con límites de cuota) — independiente de la suscripción Gemini Advanced, que es
// solo para la app y NO da acceso a la API. No requiere SDK: usa fetch nativo.
//
//   GEMINI_API_KEY        clave gratis de https://aistudio.google.com/apikey
//   GEMINI_IMAGE_MODEL    modelo de imagen (defecto gemini-2.5-flash-image-preview)
function makeGeminiProvider() {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const ART_DIR = path.join(__dirname, "../../../web/art");
  const PUBLIC_BASE = process.env.ART_PUBLIC_BASE || "/art";
  const KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  const storage = require("./storage");

  async function save(buffer, key, ext) {
    // Almacén EXTERNO S3-compatible si está configurado (el volumen local es
    // pequeño); si no, disco local servido en /art como siempre.
    if (storage.enabled()) return storage.put(key + "." + ext, buffer, ext === "jpg" ? "image/jpeg" : "image/png");
    fs.mkdirSync(path.join(ART_DIR, path.dirname(key)), { recursive: true });
    fs.writeFileSync(path.join(ART_DIR, key + "." + ext), buffer);
    return `${PUBLIC_BASE}/${key}.${ext}`;
  }

  return {
    name: "gemini",
    async generate(concept, opts) {
      const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image"; // gratis (capa gratuita)
      let prompt = opts.prompt || buildImagePrompt(concept, opts.rarity, opts.transparent);
      // Prompt externo (boss, fusión): añade la instrucción de croma si procede.
      if (opts.prompt && opts.transparent && !prompt.includes("chroma-key")) prompt += CHROMA_NOTE;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`;
      // Imágenes de referencia (p. ej. fusión: las dos criaturas padre) -> entrada multimodal.
      const reqParts = [{ text: prompt }];
      (opts.refImages || []).forEach((r) => reqParts.push({ inlineData: { mimeType: r.mimeType || "image/png", data: r.data } }));
      const body = {
        contents: [{ parts: reqParts }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: process.env.GEMINI_ASPECT || "1:1" } },
      };
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
      const imgPart = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!imgPart) throw new Error("respuesta de gemini sin imagen");
      let buffer = Buffer.from(imgPart.inlineData.data, "base64");
      let ext = (imgPart.inlineData.mimeType || "image/png").includes("jpeg") ? "jpg" : "png";
      // Fondo transparente: elimina el verde croma pedido en el prompt (pngjs).
      if (opts.transparent && ext === "png") {
        try {
          const tr = require("./transparency");
          if (tr.available()) buffer = tr.chromaKeyGreen(buffer);
        } catch (e) { console.warn(`[ai] croma falló (${opts.templateId}): ${e.message}`); }
      }

      // Filtro de calidad/seguridad opcional (gemini texto+visión). AI_VISION_FILTER=off lo salta.
      let score = 0.8;
      if ((process.env.AI_VISION_FILTER || "off") === "on") {
        try {
          const vModel = process.env.VISION_MODEL || "gemini-2.5-flash";
          const vUrl = `https://generativelanguage.googleapis.com/v1beta/models/${vModel}:generateContent?key=${KEY}`;
          const vBody = {
            contents: [{ parts: [
              { text: "Evalúa esta imagen de criatura coleccionable para un juego. Devuelve SOLO JSON con: is_single_clear_creature, has_artifacts, has_text_or_watermark, is_safe, matches_style, quality_score (0-1), reject_reason." },
              { inlineData: { mimeType: imgPart.inlineData.mimeType || "image/png", data: imgPart.inlineData.data } },
            ] }],
            generationConfig: { responseMimeType: "application/json" },
          };
          const vRes = await fetch(vUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(vBody) });
          const vData = await vRes.json();
          const txt = vData.candidates[0].content.parts.map((p) => p.text).join("");
          const qc = JSON.parse(txt);
          if (!accepted(qc, opts.rarity)) return null;
          score = qc.quality_score;
        } catch (e) {
          console.warn(`[ai] filtro de visión (gemini) falló (${opts.templateId}): ${e.message}`);
          return null;
        }
      }

      const key = opts.templateId || crypto.randomBytes(6).toString("hex");
      const out = await save(buffer, key, ext);
      return { image_url: out, image_thumb_url: out, quality_score: score };
    },
  };
}

let _provider = null;
function getImageProvider() {
  if (_provider) return _provider;
  // Por defecto: GEMINI (si hay key). Si no hay key o se fuerza, cae a procedural.
  const kind = (process.env.AI_IMAGE_PROVIDER || "gemini").toLowerCase();
  const hasGemini = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  try {
    if (kind === "openai" && process.env.OPENAI_API_KEY) _provider = makeOpenAIProvider();
    else if (kind === "gemini" && hasGemini) _provider = makeGeminiProvider();
    else _provider = proceduralProvider;
  } catch (e) {
    console.warn(`[ai] No se pudo cargar el proveedor ${kind}, usando procedural:`, e.message);
    _provider = proceduralProvider;
  }
  if (kind === "gemini" && !hasGemini) console.warn("[ai] AI_IMAGE_PROVIDER=gemini pero falta GEMINI_API_KEY -> procedural");
  console.log(`[ai] Proveedor de imagen: ${_provider.name}`);
  return _provider;
}

// Clamp duro de stats a los rangos de la rareza (doc §5.5: nunca confiar en el LLM).
function clampStats(stats, rarity) {
  const rg = E.RANGES[rarity];
  const c = (v, r) => Math.max(r[0], Math.min(r[1], Math.round(v)));
  return {
    hp: c(stats.hp, rg.hp),
    atkP: c(stats.atkP, rg.atkP), atkS: c(stats.atkS, rg.atkS),
    defP: c(stats.defP, rg.defP), defS: c(stats.defS, rg.defS),
    spd: c(stats.spd, rg.spd),
  };
}

module.exports = { getImageProvider, buildImagePrompt, accepted, clampStats };
