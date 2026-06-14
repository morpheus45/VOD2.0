// sw.js — PIPSILY v5.1 — install tolerant + activation sans reload forcé
const CACHE = "pipsily-v219";
const SHELL = ["./","./index.html","./login.html","./account.html","./admin.html","./player.html","./install.html","./vitrine.html","./merci.html","./samsung-tv.html","./styles.css?v=106","./player.css","./app.js?v=175","./auth.js","./player.js?v=51","./manifest.webmanifest","./logo.svg","./icons/icon-192.png","./icons/icon-512.png","./version.json","./icons/splash/splash-750x1334.png","./icons/splash/splash-1170x2532.png","./icons/splash/splash-1179x2556.png","./icons/splash/splash-1290x2796.png","./icons/splash/splash-1320x2868.png","./icons/splash/splash-1668x2388.png","./icons/splash/splash-2048x2732.png"];

// ── Installation : vider anciens caches + mettre en cache le shell ──
// Promise.allSettled → une image manquante ne casse plus toute l'installation
self.addEventListener("install", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => caches.open(CACHE).then(c =>
        Promise.allSettled(SHELL.map(url => c.add(url).catch(() => {})))
      ))
      .then(() => self.skipWaiting())
  );
});

// ── Activation : supprimer vieux caches + prendre le contrôle des pages ──
// PAS de RELOAD forcé — évite la bannière "mise à jour" à chaque démarrage
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Message SKIP_WAITING (bouton "Mettre à jour" dans l'app) ──
self.addEventListener("message", e => {
  if(e.data?.type === "SKIP_WAITING"){
    self.skipWaiting().then(() => {
      self.clients.matchAll({ type:"window" }).then(clients =>
        clients.forEach(c => c.postMessage({ type:"RELOAD" }))
      );
    });
  }
});

// ── Fetch : network-first pour JSON/M3U, cache-first pour assets ──
self.addEventListener("fetch", e => {
  const { request } = e;
  if(request.method !== "GET") return;
  const url = new URL(request.url);
  const isData = url.pathname.endsWith(".json") || url.pathname.endsWith(".m3u");
  if(isData){
    e.respondWith(fetch(request).catch(() => caches.match(request)));
    return;
  }
  e.respondWith(
    caches.match(request).then(cached => {
      const net = fetch(request).then(r => {
        if(url.origin === self.location.origin && r.ok){
          caches.open(CACHE).then(c => c.put(request, r.clone())).catch(()=>{});
        }
        return r;
      });
      return cached || net.catch(() => request.mode === "navigate" ? caches.match("./index.html") : cached);
    })
  );
});
