// =============================================================================
// config.js — Constantes de juego + RNG + escalado.
//
// Re-exporta el MOTOR COMPARTIDO (web/engine.js), que es la única fuente de
// verdad para cliente, servidor y tests. Así el invariante del README
// ("cliente y servidor idénticos") se cumple por construcción: no hay copias.
// =============================================================================
module.exports = require("../../web/engine.js");
