// Phase 5: ServiceWorker disabled — POS operational state must not be served stale.
// This file intentionally unregisters any previously installed waiter SW and clears caches.
// Offline support is not a business requirement for /manager/reports or live boards.
// If offline is ever required, replace with explicit safe caching (never cache /api/orders).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      try { await self.registration.unregister(); } catch {}
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});
self.addEventListener("fetch", () => {});
