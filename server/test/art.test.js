// =============================================================================
// art.test.js — Eliminación de fondo del arte IA (ai/transparency).
// Imágenes sintéticas: criatura neón sobre fondo verde croma / fondo oscuro.
// Se salta si falta la dependencia opcional pngjs.
// =============================================================================
const test = require("node:test");
const assert = require("node:assert/strict");
const tr = require("../src/ai/transparency");

let PNG = null;
try { PNG = require("pngjs").PNG; } catch (e) { /* opcional */ }

// Imagen W×H con fondo `bg` y un bloque "criatura" `fg` centrado (con contorno
// oscuro `outline` de 1px y un "ojo" oscuro interior para simular el sprite real).
function synth(W, H, bg, fg, outline, eye) {
  const png = new PNG({ width: W, height: H });
  const set = (x, y, c) => { const i = (y * W + x) * 4; png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, bg);
  const x0 = (W / 4) | 0, x1 = (3 * W / 4) | 0, y0 = (H / 4) | 0, y1 = (3 * H / 4) | 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const edge = x === x0 || x === x1 - 1 || y === y0 || y === y1 - 1;
    set(x, y, edge && outline ? outline : fg);
  }
  if (eye) set((W / 2) | 0, (H / 2) | 0, eye); // píxel oscuro DENTRO de la criatura
  return PNG.sync.write(png);
}
const alphaAt = (buf, x, y) => { const png = PNG.sync.read(buf); return png.data[(y * png.width + x) * 4 + 3]; };

test("croma verde: el fondo se vuelve transparente y la criatura queda opaca", { skip: !PNG }, () => {
  const buf = synth(64, 64, [0, 255, 0], [52, 245, 228], [12, 10, 26]);
  const out = tr.chromaKeyGreen(buf);
  assert.equal(alphaAt(out, 1, 1), 0, "esquina (fondo verde) transparente");
  assert.equal(alphaAt(out, 32, 32), 255, "centro (criatura cian) opaco");
  assert.equal(alphaAt(out, 16, 16), 255, "contorno oscuro opaco");
});

test("croma verde: una criatura PLANTA (verde apagado) NO se borra", { skip: !PNG }, () => {
  // Verde de planta típico (#3a7d2c): poco saturado respecto a #00ff00.
  const buf = synth(64, 64, [0, 255, 0], [58, 125, 44], null);
  const out = tr.chromaKeyGreen(buf);
  assert.equal(alphaAt(out, 32, 32), 255, "el verde de la criatura sobrevive");
  assert.equal(alphaAt(out, 1, 1), 0, "el verde croma del fondo no");
});

test("croma verde: fondo con SOMBRA/degradado se elimina (regresión del bug)", { skip: !PNG }, () => {
  // El bug real: Gemini deja el verde con degradado/sombra; el umbral global
  // antiguo no lo pillaba y sobraba verde. El flood-fill sí lo quita entero.
  const grad = new PNG({ width: 48, height: 48 });
  for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) {
    const i = (y * 48 + x) * 4;
    const inCreature = x >= 16 && x < 32 && y >= 16 && y < 32;
    const c = inCreature ? [40, 60, 220] : [18, 110 + ((x + y) % 70), 28]; // bg = verde con degradado
    grad.data[i] = c[0]; grad.data[i + 1] = c[1]; grad.data[i + 2] = c[2]; grad.data[i + 3] = 255;
  }
  const buf = PNG.sync.write(grad);
  assert.equal(tr.hasGreenBg(buf), true, "se detecta como fondo verde aunque tenga degradado");
  const out = tr.chromaKeyGreen(buf);
  assert.equal(alphaAt(out, 1, 1), 0, "esquina (verde sombreado) transparente");
  assert.equal(alphaAt(out, 2, 40), 0, "otro borde verde sombreado transparente");
  assert.equal(alphaAt(out, 24, 24), 255, "criatura azul opaca");
});

test("recorte adaptativo (arte antiguo): fondo oscuro fuera, interior protegido", { skip: !PNG }, () => {
  // Ojo oscuro [12,10,26] DENTRO de la criatura: casi idéntico al fondo, pero al
  // no estar conectado al exterior el flood-fill no debe tocarlo.
  const buf = synth(64, 64, [10, 8, 24], [255, 77, 157], [12, 10, 26], [12, 10, 26]);
  const out = tr.keyEdgesAdaptive(buf);
  assert.equal(alphaAt(out, 1, 1), 0, "fondo transparente");
  assert.equal(alphaAt(out, 33, 33), 255, "criatura opaca");
  assert.equal(alphaAt(out, 32, 32), 255, "ojo oscuro interior protegido (no conectado)");
  // Tradeoff conocido: el contorno de 1px que TOCA el fondo y se le parece sí se
  // elimina (queda transparente) — visualmente irrelevante en sprites neón.
  assert.equal(alphaAt(out, 16, 16), 0, "contorno pegado al fondo: eliminado");
});

test("recorte adaptativo: idempotencia vía hasTransparency", { skip: !PNG }, () => {
  const buf = synth(32, 32, [10, 8, 24], [255, 210, 63], null);
  assert.equal(tr.hasTransparency(buf), false);
  const out = tr.keyEdgesAdaptive(buf);
  assert.equal(tr.hasTransparency(out), true, "tras el recorte hay alfa");
});
