/* eslint-disable */
// Pylon service worker.
//
// Scope: this file MUST live at /sw.js (root of public/) so the
// service worker can control the entire site — service workers can
// only control pages at or below their own URL.
//
// Strategy: network-first for navigations, cache the offline shell
// as a fallback. Pylon data (rankings, leagues, market values) updates
// frequently, so we deliberately do NOT cache HTML or API responses
// for offline use — that would risk showing stale numbers, which is
// worse than showing the offline page. Static assets (/_next/static/*,
// hashed URLs) are immutable so the browser HTTP cache handles them
// fine; we don't need to duplicate that work in the SW.
//
// The version string in CACHE_NAME forces a cache wipe on each deploy
// when bumped. We bump it manually when changing this file.

const CACHE_NAME = "pylon-shell-v1";
const OFFLINE_URL = "/offline";

// On install, pre-cache the offline page so we have something to show
// when navigations fail. self.skipWaiting() lets the new SW take over
// immediately on update instead of waiting for all tabs to close.
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      self.skipWaiting();
    })(),
  );
});

// On activate, drop any old caches from prior versions and claim
// already-open clients so they start using this SW without a reload.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// Network-first for navigations only. Other requests (assets, API
// calls, RSC payloads) pass through untouched — letting the browser
// and Next.js handle caching with their normal HTTP semantics.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.mode !== "navigate") return;

  event.respondWith(
    (async () => {
      try {
        // preloadResponse is enabled by Next.js automatically when the
        // browser supports it — saves a roundtrip on cold loads.
        const preload = await event.preloadResponse;
        if (preload) return preload;
        return await fetch(req);
      } catch {
        // True offline: serve the cached offline page. If even that's
        // missing (first-load offline edge case), fall through to a
        // generic Response so we don't throw.
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(OFFLINE_URL);
        return (
          cached ??
          new Response("Offline", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          })
        );
      }
    })(),
  );
});

// Enable navigation preload where supported (most Chromium browsers).
// This is a minor perf win on first navigation after activation.
self.addEventListener("activate", (event) => {
  if (self.registration.navigationPreload) {
    event.waitUntil(self.registration.navigationPreload.enable());
  }
});
