// =============================================================================
// features.js — Flags de funcionalidad (las 7 mecánicas innovadoras). Cada una
// se enciende/apaga por env SIN tocar código; el cliente las pide en /features
// y oculta su UI cuando están off. Por defecto TODAS activas (FEATURE_<X>=off
// para desactivar una). FEATURES_ALL=off las apaga todas de golpe (kill-switch).
//
//   puzzle   — Puzzle Diario (combate-reto idéntico para todos, mín. turnos)
//   echoes   — Ecos en la Mazmorra (equipos caídos como encuentros de otros)
//   worldboss— Jefe Mundial (raid cooperativa con HP global, fin de semana)
//   nemesis  — Némesis (rival IA recurrente con counter-pick e historia)
//   prismatic— Variantes Prismáticas (1% determinista, cosmético)
//   oracle   — El Oráculo (profecía del lote de mañana) + crónicas
//   arena    — Arena Sellada (draft del lote, PvP sin colección)
// =============================================================================
const DEFS = ["puzzle", "echoes", "worldboss", "nemesis", "prismatic", "oracle", "arena"];

const allOff = process.env.FEATURES_ALL === "off";
function on(key) {
  if (allOff) return false;
  return process.env["FEATURE_" + key.toUpperCase()] !== "off"; // activa salvo "off"
}

const flags = () => DEFS.reduce((o, k) => ((o[k] = on(k)), o), {});

module.exports = { DEFS, on, flags };
