// =============================================================================
// ai/transparency.js — Eliminación de fondo de los sprites IA (PNG con alfa).
//
// Dos modos, según el origen del arte:
//   chromaKeyGreen(buffer) — arte NUEVO: el prompt pide fondo verde croma puro
//     (#00FF00); aquí se eliminan los píxeles verde-dominantes y se hace un
//     "despill" suave en los bordes. Fiable porque controlamos el fondo.
//   keyEdgesAdaptive(buffer) — arte ANTIGUO (fondo oscuro horneado): muestrea
//     el color de las 4 esquinas y hace flood-fill desde TODOS los bordes
//     eliminando solo la región contigua de color parecido. Conservador para
//     no comerse el contorno oscuro de la criatura (tolerancia estrecha).
//
// Dependencia: pngjs (opcional, pura JS). Si falta, las funciones devuelven el
// buffer original sin tocar (el pipeline sigue funcionando con fondo).
// =============================================================================
let PNG = null;
try { PNG = require("pngjs").PNG; } catch (e) { /* opcional */ }
let JPEG = null;
try { JPEG = require("jpeg-js"); } catch (e) { /* opcional */ }

const available = () => !!PNG;

// JPEG -> PNG (RGBA) en JS puro: Gemini a veces devuelve image/jpeg, que no
// admite transparencia y se saltaba el croma (la única del día salió con el
// fondo verde horneado). Convertimos y el pipeline de croma sigue igual.
const canConvertJpeg = () => !!(PNG && JPEG);
function jpegToPng(buffer) {
  if (!canConvertJpeg()) return null;
  const img = JPEG.decode(buffer, { maxMemoryUsageInMB: 64, formatAsRGBA: true });
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  return PNG.sync.write(png);
}

// ¿La imagen ya tiene transparencia? (para que el reprocesado sea idempotente)
function hasTransparency(buffer) {
  if (!PNG) return false;
  const png = PNG.sync.read(buffer);
  const d = png.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

// ¿Es un píxel "verde de fondo" (croma)? El croma es verde-LUZ: g domina y r,b
// son BAJOS en absoluto (#00FF00 y sus sombras/degradados: [20,120,30]…). Los
// verdes NATURALES de PLANTA ([58,125,44]) llevan más rojo/azul -> no cuelan.
// Así pillamos el fondo con sombra (causa del bug) sin comernos a las plantas.
function isBgGreen(d, i) {
  const r = d[i], g = d[i + 1], b = d[i + 2];
  return g > 90 && g - r > 40 && g - b > 40 && r < 55 && b < 70;
}
// ¿La imagen tiene un FONDO verde croma? (>25% del borde es verde dominante).
// Sirve para decidir si re-procesar aunque ya tenga algo de alfa.
function hasGreenBg(buffer) {
  if (!PNG) return false;
  const png = PNG.sync.read(buffer);
  const { width: W, height: H, data: d } = png;
  let green = 0, total = 0;
  const test = (i) => { total++; if (d[i + 3] > 0 && isBgGreen(d, i)) green++; };
  for (let x = 0; x < W; x += 2) { test((x) * 4); test(((H - 1) * W + x) * 4); }
  for (let y = 0; y < H; y += 2) { test((y * W) * 4); test((y * W + W - 1) * 4); }
  return total > 0 && green / total > 0.25;
}

// --------- arte NUEVO: croma verde (#00FF00) por FLOOD-FILL desde los bordes --
// Mucho más robusto que el umbral global anterior: elimina solo la región verde
// CONTIGUA al exterior (resiste degradados/sombra del fondo) sin comerse el
// interior; luego barre verdes puros sueltos y hace despill del halo de borde.
function chromaKeyGreen(buffer) {
  if (!PNG) return buffer;
  const png = PNG.sync.read(buffer);
  const { width: W, height: H, data: d } = png;
  const N = W * H;
  // 1. Flood-fill desde TODOS los píxeles del borde sobre verde de fondo.
  const seen = new Uint8Array(N);
  const queue = [];
  for (let x = 0; x < W; x++) { queue.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { queue.push(y * W, y * W + W - 1); }
  let removed = 0;
  while (queue.length) {
    const p = queue.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!isBgGreen(d, i)) continue;
    d[i + 3] = 0; removed++;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) queue.push(p - 1);
    if (x < W - 1) queue.push(p + 1);
    if (y > 0) queue.push(p - W);
    if (y < H - 1) queue.push(p + W);
  }
  // 2. Verdes PUROS sueltos (no contiguos al borde): restos de croma cerca de
  //    #00FF00 (los verdes naturales de PLANTA son menos saturados y sobreviven).
  for (let p = 0; p < N; p++) {
    const i = p * 4; if (d[i + 3] === 0) continue;
    if (d[i + 1] > 150 && d[i + 1] - d[i] > 90 && d[i + 1] - d[i + 2] > 90) { d[i + 3] = 0; removed++; }
  }
  // 3. Despill: a los píxeles opacos que tocan un transparente y tienen tinte
  //    verde, se les neutraliza el verde (quita el halo croma del contorno).
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x, i = p * 4; if (d[i + 3] === 0) continue;
    const adj = (d[((y) * W + Math.max(0, x - 1)) * 4 + 3] === 0) || (d[((y) * W + Math.min(W - 1, x + 1)) * 4 + 3] === 0) ||
                (d[(Math.max(0, y - 1) * W + x) * 4 + 3] === 0) || (d[(Math.min(H - 1, y + 1) * W + x) * 4 + 3] === 0);
    if (adj && d[i + 1] > d[i] && d[i + 1] > d[i + 2]) d[i + 1] = Math.max(d[i], d[i + 2]);
  }
  // Salvaguarda: si se comió casi todo, el key falló -> devolver el original.
  if (removed > N * 0.985) return buffer;
  return PNG.sync.write(png);
}

// ---- UNIVERSAL: quita CUALQUIER fondo plano (verde, morado, azul, degradado) --
// Flood-fill por CRECIMIENTO DE REGIÓN desde los bordes: un vecino es fondo si su
// color se parece (≤ tol) al del píxel actual (no a una media global), así sigue
// degradados suaves y se detiene en el borde nítido de la criatura. Protege el
// centro: si el centro queda transparente, asumimos que se comió la criatura y no
// tocamos. Subsume al croma verde y a los fondos de color sólido del modelo. */
function keyBackground(buffer, tol) {
  if (!PNG) return buffer;
  const png = PNG.sync.read(buffer);
  const { width: W, height: H, data: d } = png, N = W * H;
  const t = (tol || 38), t2 = t * t;
  const seen = new Uint8Array(N), q = [];
  const seed = (p) => { if (!seen[p]) { seen[p] = 1; q.push(p); } };
  for (let x = 0; x < W; x++) { seed(x); seed((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { seed(y * W); seed(y * W + W - 1); }
  let removed = 0;
  while (q.length) {
    const p = q.pop(), i = p * 4;
    const refTransparent = d[i + 3] === 0; // hueco alfa preexistente: solo propaga
    if (!refTransparent) { d[i + 3] = 0; removed++; }
    const x = p % W, y = (p / W) | 0;
    const grow = (np) => {
      if (seen[np]) return; const j = np * 4;
      if (d[j + 3] === 0) { seen[np] = 1; q.push(np); return; } // cruza huecos transparentes
      if (refTransparent) return; // sin color de referencia fiable, no crecer por color
      const dr = d[j] - d[i], dg = d[j + 1] - d[i + 1], db = d[j + 2] - d[i + 2];
      if (dr * dr + dg * dg + db * db <= t2) { seen[np] = 1; q.push(np); }
    };
    if (x > 0) grow(p - 1); if (x < W - 1) grow(p + 1);
    if (y > 0) grow(p - W); if (y < H - 1) grow(p + W);
  }
  const c = ((H >> 1) * W + (W >> 1)) * 4;
  if (removed > N * 0.985 || d[c + 3] === 0) return buffer; // salvaguarda: no comerse la criatura
  return PNG.sync.write(png);
}
// Fracción del BORDE que sigue OPACA (fondo de color sin quitar). >~0.4 => hay
// que reprocesar aunque la imagen tenga algo de alfa parcial.
function borderOpaqueFrac(buffer) {
  if (!PNG) return 0;
  const png = PNG.sync.read(buffer);
  const { width: W, height: H, data: d } = png;
  let op = 0, total = 0;
  const test = (i) => { total++; if (d[i + 3] > 16) op++; };
  for (let x = 0; x < W; x += 2) { test(x * 4); test(((H - 1) * W + x) * 4); }
  for (let y = 0; y < H; y += 2) { test((y * W) * 4); test((y * W + W - 1) * 4); }
  return total ? op / total : 0;
}

// --------- arte ANTIGUO: flood-fill desde los bordes (fondo oscuro) ----------
function keyEdgesAdaptive(buffer, tolerance = 42) {
  if (!PNG) return buffer;
  const png = PNG.sync.read(buffer);
  const { width: W, height: H, data: d } = png;
  // Color de fondo = media de las 4 esquinas (parches 4x4).
  let cr = 0, cg = 0, cb = 0, n = 0;
  const patch = (x0, y0) => { for (let y = y0; y < y0 + 4; y++) for (let x = x0; x < x0 + 4; x++) { const i = (y * W + x) * 4; cr += d[i]; cg += d[i + 1]; cb += d[i + 2]; n++; } };
  patch(0, 0); patch(W - 4, 0); patch(0, H - 4); patch(W - 4, H - 4);
  cr /= n; cg /= n; cb /= n;
  const isBg = (i) => {
    const dr = d[i] - cr, dg = d[i + 1] - cg, db = d[i + 2] - cb;
    return Math.sqrt(dr * dr + dg * dg + db * db) <= tolerance;
  };
  // BFS desde todos los píxeles del borde: solo se elimina la región CONTIGUA
  // al exterior (los oscuros interiores de la criatura quedan protegidos).
  const seen = new Uint8Array(W * H);
  const queue = [];
  for (let x = 0; x < W; x++) { queue.push(x, (H - 1) * W + x); }
  for (let y = 0; y < H; y++) { queue.push(y * W, y * W + W - 1); }
  let removed = 0;
  while (queue.length) {
    const p = queue.pop();
    if (seen[p]) continue;
    seen[p] = 1;
    const i = p * 4;
    if (!isBg(i)) continue;
    d[i + 3] = 0; removed++;
    const x = p % W, y = (p / W) | 0;
    if (x > 0) queue.push(p - 1);
    if (x < W - 1) queue.push(p + 1);
    if (y > 0) queue.push(p - W);
    if (y < H - 1) queue.push(p + W);
  }
  // Sanidad: si se eliminó casi todo (>97%) la imagen era plana o el key se
  // comió la criatura -> mejor devolver el original.
  if (removed > W * H * 0.97) return buffer;
  return PNG.sync.write(png);
}

module.exports = { available, hasTransparency, hasGreenBg, chromaKeyGreen, keyEdgesAdaptive, keyBackground, borderOpaqueFrac, canConvertJpeg, jpegToPng };
