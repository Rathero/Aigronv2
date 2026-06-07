// =============================================================================
// combat.js — Motor de combate DETERMINISTA y AUTORITATIVO (servidor).
//
// Re-exporta el motor compartido (web/engine.js). El servidor recalcula el
// combate con (equipos, seed, decisiones) para conceder recompensas: el cliente
// nunca declara "he ganado" (anti-trampa, ver docs §3.6 y §6.4).
// =============================================================================
const E = require("../../web/engine.js");

module.exports = {
  buildUnit: E.buildUnit,
  unitFromStats: E.unitFromStats,
  resolveBattle: E.resolveBattle,
  botTeamFromSeed: E.botTeamFromSeed,
};
