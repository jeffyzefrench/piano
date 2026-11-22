const CACHE_NAME = "piano-pwa-v3";
const NETWORK_TIMEOUT_MS = 2500;
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./audio.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { cache: "no-cache", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const response = await fetchWithTimeout(event.request);
        if (response && response.ok && response.type === "basic") {
          event.waitUntil(cache.put(event.request, response.clone()));
          return response;
        }
      } catch {
        // Offline or slow network: fall back to cache below.
      }

      const cached = await cache.match(event.request);
      if (cached) return cached;

      if (event.request.mode === "navigate") {
        const indexFallback = await cache.match("./index.html");
        if (indexFallback) return indexFallback;
      }

      return Response.error();
    })()
  );
});
