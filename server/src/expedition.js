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

// Recoge el acumulado. TODO el cálculo va en una sola sentencia SQL usando el
// expedition_at almacenado (sin round-trip del timestamp a JS): así evitamos el
// bug de precisión (timestamptz en µs vs Date en ms) que hacía fallar el lock y
// devolver "nada que recoger". Atómico y a prueba de doble-cobro: una 2ª recogida
// concurrente ve expedition_at=now() -> horas≈0 -> concede ~0.
async function collect(userId, power) {
  const r = ratePerHour(power);
  const upd = await db.query(
    `WITH cur AS (
       SELECT LEAST($2::numeric, GREATEST(0, EXTRACT(EPOCH FROM (now() - expedition_at)) / 3600.0)) AS h
         FROM users WHERE id = $1)
     UPDATE users u SET
       coins        = u.coins        + floor($3::numeric * (SELECT h FROM cur)),
       dust         = u.dust         + floor($4::numeric * (SELECT h FROM cur)),
       album_tokens = u.album_tokens + floor($5::numeric * (SELECT h FROM cur)),
       expedition_at = now()
     WHERE u.id = $1
     RETURNING floor($3::numeric * (SELECT h FROM cur))::int AS gc,
               floor($4::numeric * (SELECT h FROM cur))::int AS gd,
               floor($5::numeric * (SELECT h FROM cur))::int AS gt,
               (SELECT h FROM cur) AS h`,
    [userId, CAP_HOURS, r.coins, r.dust, TOKENS_PER_HOUR]
  );
  if (!upd.rowCount) return { error: "no_user" };
  const row = upd.rows[0];
  const collected = { coins: row.gc, dust: row.gd, tokens: row.gt };
  if (collected.coins <= 0 && collected.dust <= 0 && collected.tokens <= 0) return { collected, nothing: true };
  return { collected, hours: Math.round(Number(row.h) * 10) / 10 };
}

module.exports = { getState, collect, ratePerHour, CAP_HOURS };
