// =============================================================================
// generator.js — Generación determinista de plantillas de aigron.
//
// Re-exporta el motor compartido (web/engine.js). HOY genera la plantilla
// completa de forma determinista desde el id (sin coste de API); el arte lo
// dibuja el cliente desde `art_seed` (pixel art procedural).
//
// PRODUCCIÓN: el pipeline IA (server/src/ai/) enriquece estas plantillas con
// image_url/quality_score sin cambiar la forma de la fila en BD.
// =============================================================================
const E = require("../../web/engine.js");

module.exports = {
  genTemplate: E.genTemplate,
  dailyBatch: E.dailyBatch,
};
