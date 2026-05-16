// =====================================================================
// Service worker (Workbox / injectManifest mode).
//
// Responsibilities:
//   - Precache the app shell (HTML / JS / CSS / static assets).
//   - Network-only for Supabase API and the health probe.
//   - Cache-first for images, stale-while-revalidate for fonts.
//   - SPA navigation fallback to index.html.
//   - Background sync trigger: post DRAIN_OUTBOX to clients on activate.
//   - Listen for SKIP_WAITING.
// =====================================================================

/// <reference lib="webworker" />

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { registerRoute, NavigationRoute } from 'workbox-routing';
import { CacheFirst, StaleWhileRevalidate, NetworkOnly } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// --------------------------------------------------------------------
// Never cache Supabase API or the health probe.
// --------------------------------------------------------------------
registerRoute(({ url }) => url.hostname.endsWith('.supabase.co'), new NetworkOnly());
registerRoute(({ url }) => url.pathname === '/healthz.json',      new NetworkOnly());

// --------------------------------------------------------------------
// Static assets.
// --------------------------------------------------------------------
registerRoute(
  ({ request }) => request.destination === 'image',
  new CacheFirst({
    cacheName: 'images-v1',
    plugins: [new ExpirationPlugin({ maxEntries: 100, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  }),
);

registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
  new StaleWhileRevalidate({ cacheName: 'fonts-v1' }),
);

// --------------------------------------------------------------------
// SPA navigation fallback.
// --------------------------------------------------------------------
const navigationHandler = createHandlerBoundToURL('/index.html');
registerRoute(new NavigationRoute(navigationHandler, {
  denylist: [/^\/api\//, /^\/healthz\.json$/],
}));

// --------------------------------------------------------------------
// Sync engine integration.
// --------------------------------------------------------------------
self.addEventListener('message', evt => {
  if (evt.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', evt => {
  evt.waitUntil((async () => {
    await self.clients.claim();
    const all = await self.clients.matchAll({ includeUncontrolled: true });
    all.forEach(c => c.postMessage({ type: 'DRAIN_OUTBOX' }));
  })());
});

// Background sync — only available in some browsers.
self.addEventListener('sync', (evt: any) => {
  if (evt.tag === 'alfahad-outbox-drain') {
    evt.waitUntil((async () => {
      const all = await self.clients.matchAll({ includeUncontrolled: true });
      all.forEach(c => c.postMessage({ type: 'DRAIN_OUTBOX' }));
    })());
  }
});

export {};
