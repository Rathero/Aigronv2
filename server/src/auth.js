// =============================================================================
// auth.js — JWT propio + verificación de identidad de Apple/Google (doc §6.2).
//
// Flujo: el cliente móvil inicia sesión con Apple/Google y obtiene un id_token;
// lo manda a /auth/login; aquí se VERIFICA contra el proveedor y, solo si es
// válido, emitimos nuestro JWT de sesión.
//
// Modo desarrollo: si no se configura ningún proveedor y ALLOW_DEV_AUTH no es
// "false", se confía en el `subject` recibido (cómodo para local/CI). En
// PRODUCCIÓN pon ALLOW_DEV_AUTH=false y configura AUTH_GOOGLE_CLIENT_ID /
// AUTH_APPLE_CLIENT_ID para exigir tokens reales.
// =============================================================================
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const SECRET = process.env.JWT_SECRET || "dev-secret-cambia-esto";
const ALLOW_DEV_AUTH = process.env.ALLOW_DEV_AUTH !== "false";

// Fail-closed: sin JWT_SECRET real en producción cualquiera podría forjar
// tokens de sesión. Mejor no arrancar que arrancar inseguro.
if (process.env.NODE_ENV === "production" && SECRET === "dev-secret-cambia-esto") {
  console.error("❌ JWT_SECRET no configurado en producción. Configúralo en el entorno (p. ej. `openssl rand -hex 32`).");
  process.exit(1);
}

// Sanea un nombre visible ANTES de guardarlo: los nombres acaban en el HTML de
// otros jugadores (rankings, banners de PvP), así que aquí se eliminan los
// caracteres con significado en HTML y los de control. Defensa en el origen
// (el cliente además escapa al renderizar: dos capas).
function sanitizeName(name) {
  const clean = String(name || "")
    .replace(/[<>&"'`\\/]/g, "")
    // eslint-disable-next-line no-control-regex -- elimina chars de control a propósito
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  return clean.length >= 2 ? clean : "Jugador";
}

function sign(user) {
  return jwt.sign({ uid: user.id }, SECRET, { expiresIn: "30d" });
}

function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no_token" });
  try {
    req.userId = jwt.verify(token, SECRET).uid;
    next();
  } catch (e) {
    return res.status(401).json({ error: "bad_token" });
  }
}

// ----------------------- Verificación de proveedores ------------------------
async function verifyGoogle(idToken) {
  const clientId = process.env.AUTH_GOOGLE_CLIENT_ID;
  const resp = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken));
  if (!resp.ok) throw new Error("google_token_invalid");
  const p = await resp.json();
  if (clientId && p.aud !== clientId) throw new Error("google_aud_mismatch");
  if (p.iss !== "accounts.google.com" && p.iss !== "https://accounts.google.com") throw new Error("google_iss_mismatch");
  return { subject: p.sub, displayName: p.name || p.email || "Jugador" };
}

// Caché de claves públicas de Apple con TTL: Apple las rota, así que se
// refrescan periódicamente y también si llega un `kid` desconocido (rotación
// entre refrescos). Antes la caché era eterna y exigía reiniciar el servidor.
const APPLE_KEYS_TTL_MS = 6 * 60 * 60 * 1000; // 6 h
let _appleKeys = null;
let _appleKeysAt = 0;
async function appleKeys(force = false) {
  if (!force && _appleKeys && Date.now() - _appleKeysAt < APPLE_KEYS_TTL_MS) return _appleKeys;
  const resp = await fetch("https://appleid.apple.com/auth/keys");
  if (!resp.ok) throw new Error("apple_keys_unavailable");
  _appleKeys = (await resp.json()).keys;
  _appleKeysAt = Date.now();
  return _appleKeys;
}
async function verifyApple(idToken) {
  const clientId = process.env.AUTH_APPLE_CLIENT_ID;
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded) throw new Error("apple_token_unparseable");
  let keys = await appleKeys();
  let jwk = keys.find((k) => k.kid === decoded.header.kid);
  if (!jwk) {
    keys = await appleKeys(true); // kid desconocido: puede ser rotación reciente
    jwk = keys.find((k) => k.kid === decoded.header.kid);
  }
  if (!jwk) throw new Error("apple_kid_unknown");
  const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const opts = { algorithms: ["RS256"], issuer: "https://appleid.apple.com" };
  if (clientId) opts.audience = clientId;
  const p = jwt.verify(idToken, pubKey, opts);
  return { subject: p.sub, displayName: p.email || "Jugador" };
}

// Devuelve { subject, displayName } o lanza si el token no es válido.
async function verifyIdentity({ provider, subject, idToken, displayName }) {
  let out;
  if (provider === "google") out = await verifyGoogle(idToken);
  else if (provider === "apple") out = await verifyApple(idToken);
  else if (ALLOW_DEV_AUTH) {
    // provider 'dev' o desconocido
    if (!subject) throw new Error("subject_required");
    out = { subject, displayName: displayName || "Jugador" };
  } else {
    throw new Error("dev_auth_disabled");
  }
  // El nombre viene del proveedor o del cliente: SIEMPRE saneado antes de BD.
  out.displayName = sanitizeName(out.displayName);
  return out;
}

// Verifica un JWT de sesión y devuelve el userId (uid), o null si es inválido.
// Lo usa el servidor WebSocket (PvP en vivo) para autenticar la conexión.
function verifyToken(token) {
  try { return jwt.verify(token, SECRET).uid; } catch (e) { return null; }
}

module.exports = { sign, authMiddleware, verifyIdentity, verifyToken, sanitizeName, ALLOW_DEV_AUTH, GOOGLE_CLIENT_ID: process.env.AUTH_GOOGLE_CLIENT_ID || "" };
