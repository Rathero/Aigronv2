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

// Re-exporta el motor completo (igual que config.js): el job de generación usa
// además seasonKey/composeSeason/dailyEvent/dailyUnique/TYPES/hashStr… Exponerlo
// entero evita desincronizaciones y mantiene la paridad por construcción.
module.exports = E;
