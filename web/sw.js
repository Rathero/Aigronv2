// sw.js — Service worker. Estrategia:
//   - Código de la app (index.html, engine.js, navegación): NETWORK-FIRST -> siempre
//     fresco (los despliegues llegan al instante); si no hay red, cae a la caché.
//   - Arte (/art, inmutable): CACHE-FIRST (rápido, ahorra datos).
//   - API (/me, /daily, /battle, ...): red directa (datos de juego al día).
const CACHE = "aigrons-v3"; // bump: CSS/JS extraídos de index.html a ficheros propios
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/engine.js", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // escrituras de API -> red
  const url = new URL(e.request.url);
  const isArt = url.pathname.startsWith("/art/");
  const isShell = e.request.mode === "navigate" || SHELL.includes(url.pathname);

  if (isArt) {
    // cache-first
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((resp) => {
      const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return resp;
    })));
    return;
  }
  if (isShell) {
    // network-first (actualiza caché; offline -> caché)
    e.respondWith(
      fetch(e.request).then((resp) => {
        const copy = resp.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return resp;
      }).catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
    );
    return;
  }
  // resto (API y demás): red por defecto
});
