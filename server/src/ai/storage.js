// =============================================================================
// ai/storage.js — Almacenamiento EXTERNO del arte (S3-compatible, opcional).
//
// El volumen de Railway es pequeño (500MB en el plan básico) y el arte IA crece
// sin parar (álbum mensual + variantes + únicas). Este adaptador sube el arte a
// cualquier almacén con API S3 — todos con capa gratuita de sobra:
//   - Cloudflare R2  (10 GB gratis, sin coste de salida)  <- recomendado
//   - Backblaze B2   (10 GB gratis)
//   - Firebase/GCS   (vía interoperabilidad S3 con claves HMAC)
//   - AWS S3
//
// Config por variables de entorno (sin ninguna, se usa el disco local /art):
//   ART_S3_ENDPOINT    p.ej. https://<account>.r2.cloudflarestorage.com
//   ART_S3_BUCKET      nombre del bucket
//   ART_S3_ACCESS_KEY  clave de acceso
//   ART_S3_SECRET_KEY  clave secreta
//   ART_S3_REGION      región para la firma (defecto "auto"; GCS/B2: la suya)
//   ART_PUBLIC_BASE    URL pública base del bucket (p.ej. https://pub-xxx.r2.dev)
//
// Firma AWS SigV4 implementada con el crypto nativo (cero dependencias). Se usa
// path-style (endpoint/bucket/key): funciona en R2, B2, GCS y S3.
// =============================================================================
const crypto = require("crypto");

const cfg = () => ({
  endpoint: process.env.ART_S3_ENDPOINT,
  bucket: process.env.ART_S3_BUCKET,
  key: process.env.ART_S3_ACCESS_KEY,
  secret: process.env.ART_S3_SECRET_KEY,
  region: process.env.ART_S3_REGION || "auto",
  publicBase: (process.env.ART_PUBLIC_BASE || "").replace(/\/$/, ""),
});

function enabled() {
  const c = cfg();
  return !!(c.endpoint && c.bucket && c.key && c.secret && c.publicBase && /^https?:\/\//.test(c.publicBase));
}

// ------------------------------ firma SigV4 ----------------------------------
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function sign(method, url, extraHeaders, payloadHash) {
  const c = cfg();
  const u = new URL(url);
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);
  // Mapa normalizado en minúsculas (la canónica exige claves lowercase ordenadas).
  const h = {};
  for (const [k, v] of Object.entries(extraHeaders || {})) h[k.toLowerCase()] = String(v).trim();
  h.host = u.host;
  h["x-amz-date"] = amzDate;
  h["x-amz-content-sha256"] = payloadHash;

  const sortedKeys = Object.keys(h).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${h[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");
  // u.pathname ya viene percent-encoded (objectUrl codifica cada segmento).
  const canonicalRequest = [method, u.pathname, u.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac("AWS4" + c.secret, dateStamp), c.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  h.authorization = `AWS4-HMAC-SHA256 Credential=${c.key}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return h;
}

const objectUrl = (key) => {
  const c = cfg();
  return `${c.endpoint.replace(/\/$/, "")}/${c.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
};

// fetch con el error de RED desempaquetado: el "fetch failed" de undici esconde
// la causa real (ENOTFOUND, ECONNREFUSED, cert...) en e.cause — sin esto el
// diagnóstico de un endpoint mal escrito es imposible desde los logs.
async function s3fetch(url, opts) {
  try {
    return await fetch(url, opts);
  } catch (e) {
    const cause = e.cause ? ` (${e.cause.code || e.cause.message})` : "";
    throw new Error(`no se pudo conectar con ${new URL(url).host}${cause} — revisa ART_S3_ENDPOINT`, { cause: e });
  }
}

// Sube un buffer y devuelve su URL PÚBLICA (la que se guarda en image_url).
async function put(key, buffer, contentType = "image/png") {
  const url = objectUrl(key);
  const headers = sign("PUT", url, { "content-type": contentType, "content-length": String(buffer.length) }, sha256(buffer));
  const res = await s3fetch(url, { method: "PUT", headers, body: buffer });
  if (!res.ok) throw new Error(`storage PUT ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return `${cfg().publicBase}/${key}`;
}

// Descarga un objeto del bucket (por su clave) o cualquier URL http(s) pública.
async function getBuffer(urlOrKey) {
  let url = urlOrKey;
  let headers = {};
  if (!/^https?:\/\//.test(urlOrKey)) {
    url = objectUrl(urlOrKey);
    headers = sign("GET", url, {}, sha256(""));
  }
  const res = await s3fetch(url, { headers });
  if (!res.ok) throw new Error(`storage GET ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

// Clave del objeto a partir de la URL pública (inversa de put), o null si no es del bucket.
function keyFromUrl(url) {
  const base = cfg().publicBase;
  if (base && url && url.startsWith(base + "/")) return url.slice(base.length + 1);
  return null;
}

// AUTODIAGNÓSTICO de la configuración (tarea admin art-storage-test): sube un
// objeto de prueba, lo relee firmado y lo relee por la URL PÚBLICA. Cada paso
// reporta ok/fallo con causa, para distinguir endpoint mal escrito (red),
// credenciales malas (403) o acceso público sin activar (404 en el último paso).
async function selfTest() {
  const c = cfg();
  const missing = ["ART_S3_ENDPOINT", "ART_S3_BUCKET", "ART_S3_ACCESS_KEY", "ART_S3_SECRET_KEY", "ART_PUBLIC_BASE"]
    .filter((k) => !process.env[k]);
  const out = {
    config: { endpoint: c.endpoint || null, bucket: c.bucket || null, region: c.region, publicBase: c.publicBase || null, missing },
  };
  if (missing.length) { out.verdict = "faltan variables: " + missing.join(", "); return out; }
  const key = "_diag/test-" + Date.now() + ".txt";
  const payload = Buffer.from("aigrons storage self-test");
  try { out.putPublicUrl = await put(key, payload, "text/plain"); out.put = "ok"; }
  catch (e) { out.put = e.message; out.verdict = "PUT falló: endpoint o credenciales mal (403=claves, 'no se pudo conectar'=endpoint)"; return out; }
  try { const b = await getBuffer(key); out.getSigned = b.equals(payload) ? "ok" : "contenido distinto"; }
  catch (e) { out.getSigned = e.message; }
  try {
    const res = await fetch(out.putPublicUrl);
    out.getPublic = res.ok ? "ok" : `HTTP ${res.status}`;
    if (!res.ok) out.verdict = "el bucket funciona pero ART_PUBLIC_BASE no sirve los objetos: activa el acceso público (r2.dev / dominio) o corrige la URL";
  } catch (e) { out.getPublic = e.message; out.verdict = "ART_PUBLIC_BASE no responde: revisa la URL pública"; }
  if (!out.verdict) out.verdict = "todo OK: puedes lanzar art-migrate";
  return out;
}

module.exports = { enabled, put, getBuffer, keyFromUrl, selfTest };
