// sw.js — Service worker mínimo: cachea el "shell" de la app (para instalación PWA
// y carga rápida/offline del armazón) y el arte (/art, inmutable). El resto de
// peticiones (API: /me, /daily, /battle, etc.) pasan SIEMPRE a la red para no
// servir datos de juego obsoletos.
const CACHE = "aigrons-v1";
const SHELL = ["/", "/index.html", "/engine.js", "/manifest.webmanifest", "/icon.svg"];

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
  const isShell = SHELL.includes(url.pathname) || url.pathname.startsWith("/art/");
  if (!isShell) return; // API y demás -> red (comportamiento por defecto)
  // Shell/arte: cache-first con relleno en segundo plano.
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit || fetch(e.request).then((resp) => {
        const copy = resp.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return resp;
      }).catch(() => hit)
    )
  );
});
