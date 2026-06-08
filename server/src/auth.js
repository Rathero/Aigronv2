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

if (process.env.NODE_ENV === "production" && SECRET === "dev-secret-cambia-esto") {
  console.warn("⚠️  JWT_SECRET no configurado en producción. Configúralo en el entorno.");
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

let _appleKeys = null;
async function appleKeys() {
  if (_appleKeys) return _appleKeys;
  const resp = await fetch("https://appleid.apple.com/auth/keys");
  if (!resp.ok) throw new Error("apple_keys_unavailable");
  _appleKeys = (await resp.json()).keys;
  return _appleKeys;
}
async function verifyApple(idToken) {
  const clientId = process.env.AUTH_APPLE_CLIENT_ID;
  const decoded = jwt.decode(idToken, { complete: true });
  if (!decoded) throw new Error("apple_token_unparseable");
  const keys = await appleKeys();
  const jwk = keys.find((k) => k.kid === decoded.header.kid);
  if (!jwk) throw new Error("apple_kid_unknown");
  const pubKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const opts = { algorithms: ["RS256"], issuer: "https://appleid.apple.com" };
  if (clientId) opts.audience = clientId;
  const p = jwt.verify(idToken, pubKey, opts);
  return { subject: p.sub, displayName: p.email || "Jugador" };
}

// Devuelve { subject, displayName } o lanza si el token no es válido.
async function verifyIdentity({ provider, subject, idToken, displayName }) {
  if (provider === "google") return verifyGoogle(idToken);
  if (provider === "apple") return verifyApple(idToken);
  // provider 'dev' o desconocido
  if (ALLOW_DEV_AUTH) {
    if (!subject) throw new Error("subject_required");
    return { subject, displayName: displayName || "Jugador" };
  }
  throw new Error("dev_auth_disabled");
}

// Verifica un JWT de sesión y devuelve el userId (uid), o null si es inválido.
// Lo usa el servidor WebSocket (PvP en vivo) para autenticar la conexión.
function verifyToken(token) {
  try { return jwt.verify(token, SECRET).uid; } catch (e) { return null; }
}

module.exports = { sign, authMiddleware, verifyIdentity, verifyToken, ALLOW_DEV_AUTH, GOOGLE_CLIENT_ID: process.env.AUTH_GOOGLE_CLIENT_ID || "" };
