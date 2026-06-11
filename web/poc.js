// =============================================================================
// poc.js — PRUEBA DE CONCEPTO de estilo (reversible, NO afecta a nadie sin flag).
// Activar con ?poc=juice|ui|full :
//   juice — pixel art + game feel (partículas, screen shake, confeti)
//   ui    — lo anterior + restyle moderno de la UI (poc.css) · criaturas pixel
//   full  — lo anterior + render SUAVE de las criaturas (mismo sprite, blobs/glow)
// El motor determinista NO se toca. Sin ?poc=, este archivo no hace nada.
// =============================================================================
(function () {
  var mode = new URLSearchParams(location.search).get("poc");
  if (!["juice", "ui", "full"].includes(mode)) return;
  document.documentElement.dataset.poc = mode;

  // -------------------------------- partículas -------------------------------
  var fx = document.createElement("canvas");
  fx.id = "poc-fx";
  fx.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:90";
  function sizeFx() { fx.width = innerWidth; fx.height = innerHeight; }
  addEventListener("resize", sizeFx);
  window.addEventListener("DOMContentLoaded", function () { document.body.appendChild(fx); sizeFx(); });
  var ctx = fx.getContext("2d");
  var parts = [], raf = null;
  function tick() {
    ctx.clearRect(0, 0, fx.width, fx.height);
    for (var i = parts.length - 1; i >= 0; i--) {
      var p = parts[i];
      p.life--; if (p.life <= 0) { parts.splice(i, 1); continue; }
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.vx *= 0.96;
      var a = Math.max(0, p.life / p.max);
      ctx.globalAlpha = a; ctx.fillStyle = p.c;
      if (p.sq) { ctx.fillRect(p.x, p.y, p.s, p.s); }
      else { ctx.beginPath(); ctx.arc(p.x, p.y, p.s * a + 0.5, 0, 7); ctx.fill(); }
    }
    ctx.globalAlpha = 1;
    raf = parts.length ? requestAnimationFrame(tick) : null;
  }
  function spawn(list) { parts.push.apply(parts, list); if (!raf) raf = requestAnimationFrame(tick); }

  // ------------------------------ API de juice -------------------------------
  function burst(cx, cy, n, colors, power, square) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var ang = Math.random() * 7, sp = power * (0.4 + Math.random());
      out.push({ x: cx, y: cy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - power * 0.3,
        g: 0.18, life: 28 + Math.random() * 20, max: 48, s: 2 + Math.random() * 3,
        c: colors[(Math.random() * colors.length) | 0], sq: square });
    }
    spawn(out);
  }
  function shake(strong) {
    var app = document.getElementById("app"); if (!app) return;
    app.classList.remove("poc-shake", "poc-shake-strong"); void app.offsetWidth;
    app.classList.add(strong ? "poc-shake-strong" : "poc-shake");
    setTimeout(function () { app.classList.remove("poc-shake", "poc-shake-strong"); }, 320);
  }

  window.POC = {
    mode: mode,
    juice: true,
    smooth: mode === "full",
    onHit: function (el, h) {
      var r = el.getBoundingClientRect();
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (h.crit) { burst(cx, cy, 22, ["#ffd23f", "#fff7c8", "#ff4d9d"], 7); shake(true); }
      else { burst(cx, cy, 11, h.typeM > 1 ? ["#ff4d9d", "#fff"] : ["#34f5e4", "#fff"], 4.5); shake(false); }
    },
    confetti: function () {
      var cols = ["#34f5e4", "#ff4d9d", "#ffd23f", "#7CFF6B", "#c061ff"], out = [];
      for (var i = 0; i < 70; i++) out.push({ x: Math.random() * innerWidth, y: -10 - Math.random() * 80,
        vx: (Math.random() - 0.5) * 2, vy: 1 + Math.random() * 2, g: 0.06,
        life: 90 + Math.random() * 50, max: 140, s: 3 + Math.random() * 3,
        c: cols[(Math.random() * cols.length) | 0], sq: true });
      spawn(out);
    },
    // ----------------------- render SUAVE (modo full) -----------------------
    // Mismo sprite determinista (buildSprite + colorFor), dibujado como blobs
    // glossy con gradiente y glow en lugar de cuadrados. Cero pixel.
    drawSmooth: function (canvas, tpl, px, prismId, buildSprite, colorFor) {
      px = px || 8; var N = 16, S = 4; // supersampling para suavizar
      canvas.width = N * px; canvas.height = N * px;
      var g = canvas.getContext("2d"); g.imageSmoothingEnabled = true;
      g.clearRect(0, 0, canvas.width, canvas.height);
      var grid = buildSprite(tpl);
      var prism = prismId && window.ENGINE && ENGINE.isPrismatic(prismId);
      var R = px * 0.92; // radio del blob (solapa con vecinos -> forma continua)
      g.shadowBlur = px * 0.6; g.shadowColor = "rgba(0,0,0,.5)";
      // 1ª pasada: silueta oscura ligeramente mayor (contorno suave unificado).
      g.fillStyle = "#08060f";
      for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
        if (!colorFor(grid[y][x], tpl)) continue;
        g.beginPath(); g.arc(x * px + px / 2, y * px + px / 2, R * 1.06, 0, 7); g.fill();
      }
      g.shadowBlur = 0;
      // 2ª pasada: blobs de color con gradiente radial (luz arriba-izquierda).
      for (var yy = 0; yy < N; yy++) for (var xx = 0; xx < N; xx++) {
        var c = colorFor(grid[yy][xx], tpl); if (!c) continue;
        if (prism) c = ENGINE.prismaticShift(c, prismId);
        var ccx = xx * px + px / 2, ccy = yy * px + px / 2;
        var grd = g.createRadialGradient(ccx - R * 0.3, ccy - R * 0.3, R * 0.1, ccx, ccy, R);
        grd.addColorStop(0, mix(c, "#ffffff", 0.45));
        grd.addColorStop(0.55, c);
        grd.addColorStop(1, mix(c, "#000000", 0.25));
        g.fillStyle = grd;
        g.beginPath(); g.arc(ccx, ccy, R, 0, 7); g.fill();
      }
      void S;
    },
  };
  function mix(a, b, t) {
    var pa = hex(a), pb = hex(b);
    return "#" + [0, 1, 2].map(function (i) { return Math.round(pa[i] + (pb[i] - pa[i]) * t).toString(16).padStart(2, "0"); }).join("");
  }
  function hex(h) { var m = /^#?([0-9a-f]{6})/i.exec(h); var v = parseInt(m ? m[1] : "888888", 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255]; }
})();
