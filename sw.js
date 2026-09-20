/**
 * ============================================================
 * sw.js — Recension service worker
 * ============================================================
 *
 * Makes the app loadable without a connection. The manuscript already
 * lives in IndexedDB; before this, closing the tab offline meant the
 * shell couldn't load and you couldn't reach your own writing — a
 * strange failure for a local-first app.
 *
 * ── BUMP THIS ON EVERY DEPLOY ───────────────────────────────
 * SW_VERSION is now the ONLY thing to change when you ship. It
 * replaces the ?v=N query strings that used to hang off every
 * script and stylesheet: the cache name contains the version, so a
 * new version means a new cache, a fresh fetch of everything, and
 * the old cache deleted on activate.
 *
 * ── STRATEGIES, AND WHY EACH ────────────────────────────────
 *
 * Navigation (the page itself) — NETWORK FIRST, cache as fallback.
 *   A deploy should be visible immediately when online. Serving a
 *   cached page first would mean running yesterday's app until some
 *   later reload, which is exactly the confusion the ?v= scheme
 *   existed to avoid.
 *
 * Same-origin assets — STALE WHILE REVALIDATE.
 *   Serve from cache at once, fetch in the background, use the new
 *   copy next time. Fast start, self-healing.
 *
 * Google Fonts — CACHE FIRST, runtime.
 *   Spectral is not vendored, so without this the type silently
 *   falls back to a system serif offline — the app changes
 *   appearance at the exact moment you can't investigate why.
 *
 * The Cloudflare worker — NEVER CACHED.
 *   Sync responses are the one thing that must always be live. A
 *   cached 200 here would be a lie about the state of the account.
 *
 * Nothing in here touches IndexedDB. Sync already degrades
 * correctly offline: writes queue in the dirty set and flush when
 * the network returns.
 */

const SW_VERSION = 'v17';
const CACHE = `recension-${SW_VERSION}`;
const FONT_CACHE = 'recension-fonts';

// The shell: everything needed to open the app and reach the writing.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/auth.js',
  './js/recordStore.js',
  './js/sync.js',
  './js/app.js',
  './js/vendor/easymde.min.js',
  './js/vendor/easymde.min.css',
  './js/vendor/fflate.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

// ── Install ────────────────────────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll fails the whole install if ANY file 404s. Add them
    // individually so one missing vendor file can't leave the app with
    // no offline support at all.
    await Promise.all(SHELL.map(async url => {
      try { await cache.add(new Request(url, { cache: 'reload' })); }
      catch (e) { console.warn('[sw] could not cache', url, e); }
    }));
    self.skipWaiting();
  })());
});

// ── Activate ───────────────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    // Drop every cache from a previous version. The font cache is
    // deliberately spared: the files are immutable and re-downloading
    // several hundred kilobytes of Spectral on every deploy is waste.
    const names = await caches.keys();
    await Promise.all(names.map(n => {
      if (n === CACHE || n === FONT_CACHE) return null;
      if (!n.startsWith('recension-')) return null;
      return caches.delete(n);
    }));
    await self.clients.claim();
  })());
});

// ── Fetch ──────────────────────────────────────────────────────────

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Fonts FIRST. They live on googleapis.com and gstatic.com, so the
  // Google exclusion below would otherwise swallow them and Spectral
  // would stop being cached at all.
  if (FONT_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(req, FONT_CACHE));
    return;
  }

  // Google's sign-in machinery is never touched. Its scripts, iframes
  // and redirects are stateful and time-sensitive; anything served from
  // a cache here breaks the flow in ways that surface as a white page
  // rather than an error.
  if (url.hostname.endsWith('google.com') ||
      url.hostname.endsWith('googleapis.com') ||
      url.hostname.endsWith('googleusercontent.com') ||
      url.hostname.endsWith('gstatic.com')) {
    return;
  }

  // Sync traffic is never cached — see the header note.
  if (url.hostname.endsWith('workers.dev') ||
      url.pathname.startsWith('/storage') ||
      url.pathname.startsWith('/blob') ||
      url.pathname.startsWith('/auth')) {
    return;
  }

  // Only OUR OWN navigations. A cross-origin navigation — the Google
  // sign-in flow being the one that matters — must be left entirely
  // alone: falling back to a cached ./index.html for a request bound
  // for accounts.google.com would hand back the wrong app's HTML and
  // leave a blank, frozen window with no way out.
  if (req.mode === 'navigate' && url.origin === self.location.origin) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh.ok) cache.put(req, fresh.clone());
    return fresh;
  } catch {
    // Offline. Fall back to the cached page, then to the shell entry —
    // a deep link should still open the app rather than the browser's
    // dinosaur.
    return (await cache.match(req))
        || (await cache.match('./index.html'))
        || Response.error();
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);

  const update = fetch(req).then(res => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);

  // Serving the cached copy immediately is the whole point; the network
  // copy lands in the cache for next time.
  return hit || (await update) || Response.error();
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    // Font responses from gstatic are opaque (no CORS), and an opaque
    // response still caches and still renders — status 0 is expected
    // here and is not a failure.
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

// ── Messages ───────────────────────────────────────────────────────

self.addEventListener('message', event => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});
