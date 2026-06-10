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

const available = () => !!PNG;

// ¿La imagen ya tiene transparencia? (para que el reprocesado sea idempotente)
function hasTransparency(buffer) {
  if (!PNG) return false;
  const png = PNG.sync.read(buffer);
  const d = png.data;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 255) return true;
  return false;
}

// --------- arte NUEVO: croma verde (#00FF00) pedido en el prompt -------------
function chromaKeyGreen(buffer) {
  if (!PNG) return buffer;
  const png = PNG.sync.read(buffer);
  const d = png.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    // Verde-dominante y saturado -> fondo (los aigrons evitan verde puro por prompt).
    if (g > 150 && g > r + 70 && g > b + 70) {
      d[i + 3] = 0;
    } else {
      // Halo de borde con sangrado de croma: solo píxeles CASI verde puro
      // (distancia a #00FF00); los verdes naturales (PLANTA) quedan intactos.
      const dist = Math.sqrt(r * r + (255 - g) * (255 - g) + b * b);
      if (dist < 110) { d[i + 1] = Math.max(r, b); d[i + 3] = Math.min(d[i + 3], 140); }
    }
  }
  return PNG.sync.write(png);
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

module.exports = { available, hasTransparency, chromaKeyGreen, keyEdgesAdaptive };
