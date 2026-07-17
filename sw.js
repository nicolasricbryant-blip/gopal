// sw.js — service worker: cache-first app shell + MediaPipe wasm/model for offline use.
// Versioned cache name — bump CACHE_VERSION whenever shell files change.

const CACHE_VERSION = 'gopal-v4';
const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/main.css',
  './js/app.js',
  './js/camera.js',
  './js/detector.js',
  './js/facemath.js',
  './js/fsm.js',
  './js/assistant.js',
  './js/alerts.js',
  './js/dashboard.js',
  './js/storage.js',
  './js/metrics.js',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
];

// MediaPipe assets are large and versioned by URL, so a cache-first strategy is
// safe indefinitely — a new @mediapipe/tasks-vision version would have a new URL.
function isMediaPipeAsset(url) {
  return url.includes('cdn.jsdelivr.net/npm/@mediapipe') || url.includes('storage.googleapis.com/mediapipe-models');
}

function isGoogleFontAsset(url) {
  return url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com');
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(SHELL_FILES).catch((err) => {
        // Don't fail install if an optional shell file (e.g. an icon not yet
        // generated) is missing — log and continue with what succeeded.
        console.warn('[sw] shell cache warm-up incomplete', err);
      })
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = request.url;

  // Never cache API calls (Gemini/Claude/Telegram/geolocation-adjacent fetches) —
  // those must always hit the network so keys/alerts stay live.
  if (
    url.includes('generativelanguage.googleapis.com') ||
    url.includes('api.anthropic.com') ||
    url.includes('api.telegram.org')
  ) {
    return; // let the browser handle it normally (network only)
  }

  // Match shell files by pathname on same-origin requests only — matching the
  // raw request URL with endsWith() could otherwise match a cross-origin URL
  // that happens to share a trailing path segment (e.g. a third-party script
  // named the same as one of ours).
  // Note: the './' root entry must be excluded — it maps to the empty string,
  // and pathname.endsWith('') is true for every path, which would force ALL
  // same-origin requests through cacheFirst. The root document is matched by
  // its trailing slash below instead.
  const u = new URL(request.url);
  const isShellFile =
    u.origin === self.location.origin &&
    (u.pathname.endsWith('/') || SHELL_FILES.some((f) => f !== './' && u.pathname.endsWith(f.replace('./', ''))));
  if (isMediaPipeAsset(url) || isGoogleFontAsset(url) || isShellFile) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Default: try network, fall back to cache (works offline for anything else
  // same-origin that got cached incidentally).
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(request))
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    return cached || Response.error();
  }
}
