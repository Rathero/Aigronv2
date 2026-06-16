// =============================================================================
// expedition.js — EXPEDICIÓN idle (progreso pasivo).
//
// Tu equipo "explora" mientras NO juegas y acumula monedas + polvo, a un ritmo
// que escala con el PODER del equipo (recompensa subir nivel/evolución/colección).
// La acumulación tiene TOPE (te empuja a conectarte ~2 veces al día) y es 100%
// server-authoritative y determinista: el acumulado = (now - expedition_at)
// acotado al tope, calculado en el servidor; cero exploits de reloj del cliente.
//
// Guardarraíl de diseño: el idle da ECONOMÍA/MATERIALES, nunca rating PvP ni
// ventaja de combate pagable (la habilidad del PvP se gana jugando).
// =============================================================================
const db = require("./db");

const CAP_HOURS = parseInt(process.env.EXPEDITION_CAP_H || "12", 10); // tope de acumulación
const CAP_MS = CAP_HOURS * 3600000;

// Ritmo por hora según el poder del equipo (suma de stats escalados de los 3).
// Base útil aunque no tengas equipo fuerte; crece con la progresión.
function ratePerHour(power) {
  const p = Math.max(0, power || 0);
  return { coins: 15 + Math.floor(p / 60), dust: 3 + Math.floor(p / 300) };
}
// Fichas de álbum (progresión): NO escalan con el poder (justas para novatos);
// ~1 cada 4h -> hasta 3 por tope de 12h. Se canjean por una criatura que falta.
const TOKENS_PER_HOUR = 1 / 4;
function accrued(sinceMs, power) {
  const hours = Math.min(CAP_HOURS, Math.max(0, sinceMs / 3600000));
  const r = ratePerHour(power);
  return {
    coins: Math.floor(r.coins * hours), dust: Math.floor(r.dust * hours),
    tokens: Math.floor(TOKENS_PER_HOUR * hours), hours,
  };
}

// Estado para la UI: acumulado actual, ritmo, tope y cuándo se llena.
async function getState(userId, power) {
  const row = (await db.query("SELECT expedition_at FROM users WHERE id=$1", [userId])).rows[0];
  if (!row) return { error: "no_user" };
  const atMs = new Date(row.expedition_at).getTime();
  const since = Date.now() - atMs;
  const acc = accrued(since, power);
  return {
    pending: { coins: acc.coins, dust: acc.dust, tokens: acc.tokens },
    rate: Object.assign(ratePerHour(power), { tokensPerHour: TOKENS_PER_HOUR }),
    capHours: CAP_HOURS,
    pct: Math.max(0, Math.min(100, Math.round((since / CAP_MS) * 100))),
    full: since >= CAP_MS,
    fullAt: new Date(atMs + CAP_MS).toISOString(),
    power: Math.round(power || 0),
  };
}

// Recoge el acumulado. Atómico: el UPDATE solo aplica si expedition_at no cambió
// (optimistic lock) -> dos recogidas concurrentes no duplican la recompensa.
async function collect(userId, power) {
  const row = (await db.query("SELECT expedition_at FROM users WHERE id=$1", [userId])).rows[0];
  if (!row) return { error: "no_user" };
  const since = Date.now() - new Date(row.expedition_at).getTime();
  const acc = accrued(since, power);
  if (acc.coins <= 0 && acc.dust <= 0 && acc.tokens <= 0) return { collected: { coins: 0, dust: 0, tokens: 0 }, nothing: true };
  const upd = await db.query(
    `UPDATE users SET coins = coins + $2, dust = dust + $3, album_tokens = album_tokens + $5, expedition_at = now()
      WHERE id = $1 AND expedition_at IS NOT DISTINCT FROM $4
      RETURNING coins, dust`,
    [userId, acc.coins, acc.dust, row.expedition_at, acc.tokens]
  );
  if (!upd.rowCount) return { collected: { coins: 0, dust: 0, tokens: 0 }, raced: true };
  return { collected: { coins: acc.coins, dust: acc.dust, tokens: acc.tokens }, hours: Math.round(acc.hours * 10) / 10 };
}

module.exports = { getState, collect, ratePerHour, CAP_HOURS };
