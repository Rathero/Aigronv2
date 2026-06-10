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
// Web Push: muestra la notificación y, al tocarla, abre/enfoca el juego.
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) {}
  e.waitUntil(self.registration.showNotification(d.title || "AIGRONS", {
    body: d.body || "", tag: d.tag || "aigrons", icon: "/icon.svg", badge: "/icon.svg",
  }));
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ("focus" in c) return c.focus(); }
    return clients.openWindow("/");
  }));
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
