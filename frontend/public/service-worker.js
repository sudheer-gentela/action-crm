/* eslint-disable no-restricted-globals */
/* ============================================================================
   service-worker.js — GoWarm CRM
   ============================================================================

   react-scripts 5 dropped the built-in service worker that CRA 4 shipped, so
   this is hand-written. It uses runtime caching rather than a precache
   manifest, which means no build-plugin dependency and no generated file to
   keep in sync.

   THE ONE RULE THAT MATTERS: API responses are never cached.

   A CRM that serves a stale pipeline, a stale action queue or a stale prospect
   record is worse than one that says "you're offline". Every request to the
   API origin goes to the network and is allowed to fail. Only the application
   shell — HTML, JS, CSS, icons — is cached, and that exists purely so the app
   opens instantly and can tell you it's offline rather than showing a blank
   page.

   Update strategy: navigation requests are network-first, so a new deploy is
   picked up on the next load. Everything under /static/ is content-hashed by
   CRA, so cache-first is safe there — a new build produces new filenames.

   To roll this back, see unregister() in src/serviceWorkerRegistration.js.
   ============================================================================ */

const VERSION     = 'gw-v1';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;

// Same-origin paths that must always hit the network, regardless of anything
// below. The API normally lives on another origin (api.gowarmcrm.com) and so
// never matches our same-origin handler at all, but a same-origin proxy path
// is a common enough deployment that guarding it explicitly is worth the line.
const NEVER_CACHE = [/^\/api\//, /^\/auth\//, /^\/t\//, /^\/webhooks\//];

self.addEventListener('install', (event) => {
  // Cache the shell entry point so a cold offline start has something to show.
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(['/', '/index.html']))
      .catch(() => { /* a failed precache must not block installation */ })
  );
  // Deliberately no skipWaiting(). Taking over mid-session can leave a running
  // page talking to a worker built from different assets. The new worker
  // activates on the next load instead.
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (the API, Twilio, CDNs) — leave entirely alone.
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((re) => re.test(url.pathname))) return;

  // Navigation: network first, cache as a fallback. Keeps deploys instant.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy));
          return res;
        })
        .catch(() => caches.match('/index.html').then((r) => r || offlineResponse()))
    );
    return;
  }

  // Content-hashed build output and icons: cache first.
  if (url.pathname.startsWith('/static/') || /\.(png|svg|ico|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(ASSET_CACHE).then((c) => c.put(request, copy));
        }
        return res;
      }))
    );
  }
});

function offlineResponse() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Offline</title>'
    + '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;'
    + 'display:flex;flex-direction:column;align-items:center;justify-content:center;'
    + 'min-height:100vh;margin:0;padding:24px;text-align:center;color:#1A3A5C">'
    + '<h1 style="font-size:18px;font-weight:600;margin:0 0 8px">You\'re offline</h1>'
    + '<p style="font-size:14px;color:#6b7280;margin:0">GoWarm needs a connection to load your '
    + 'work. It will pick up where you left off once you\'re back.</p></div>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' }, status: 503 }
  );
}

/* ── Push ───────────────────────────────────────────────────────────────────
   Payload is sent by backend/services/webPush.service.js and looks like:
     { title, body, url, tag, notificationId }
   Everything is defensive: a malformed payload should still surface something
   rather than throwing inside the worker.
   ------------------------------------------------------------------------- */

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { body: event.data && event.data.text ? event.data.text() : '' };
  }

  const title = data.title || 'GoWarm CRM';
  const options = {
    body: data.body || '',
    icon: '/favicon-192x192.png',
    badge: '/favicon-192x192.png',
    // Same tag replaces an earlier notification instead of stacking a second
    // copy — useful when the action queue re-notifies about the same item.
    tag: data.tag || 'gowarm',
    renotify: Boolean(data.tag),
    data: { url: data.url || '/', notificationId: data.notificationId || null },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // Prefer focusing a tab that's already open and steering it, rather than
      // opening a duplicate. The app is a single page with hash routing, so
      // setting the hash is enough to navigate it.
      for (const win of wins) {
        if (win.url.startsWith(self.location.origin) && 'focus' in win) {
          if ('navigate' in win) win.navigate(target).catch(() => {});
          return win.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
