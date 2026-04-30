"use client";

import { useEffect } from "react";

// Registers the service worker at /sw.js once on mount. Renders nothing.
// Mounted from the root layout so it runs on every page load.
//
// We skip registration on localhost dev because the SW will aggressively
// cache the offline page, which makes "next dev" hot-reload behave
// strangely (you keep getting the offline shell after killing the dev
// server). Production-only registration keeps dev DX clean while still
// making the deployed site installable.
//
// The SW itself is at public/sw.js (served at /sw.js). Service workers
// can only control pages at or below their URL — keeping it at root
// means it controls the whole app.
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;

    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
        // Swallow registration errors — a failed SW shouldn't break
        // the app. The user will just miss the install prompt and the
        // offline shell, both of which are progressive enhancements.
      });
    };

    if (document.readyState === "complete") {
      onLoad();
    } else {
      window.addEventListener("load", onLoad, { once: true });
      return () => window.removeEventListener("load", onLoad);
    }
  }, []);

  return null;
}
