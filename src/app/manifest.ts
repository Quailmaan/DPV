import type { MetadataRoute } from "next";

// PWA manifest — served at /manifest.webmanifest. Browsers read this
// when the user taps "Add to Home Screen" (iOS) or sees the install
// prompt (Chrome/Edge/Android). Without it, the installed entry is
// just a bookmark; with it, the app launches in its own window with
// our branding instead of inside Safari/Chrome chrome.
//
// `display: "standalone"` is what makes it feel like a real app —
// no URL bar, no browser tabs. `theme_color` colors the OS status
// bar / window chrome. `background_color` is the splash screen color
// shown for the brief moment before the page renders.
//
// Icons cover three roles:
//   - "any" 192/512: standard launcher icons
//   - "maskable" 192/512: have extra padding so Android's adaptive-
//     icon shape mask (circle, squircle, etc.) doesn't crop the glyph
//   - apple-icon.png is referenced separately from the layout via
//     the apple-touch-icon meta tag (iOS doesn't read manifest icons)
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pylon — Dynasty Fantasy Football",
    short_name: "Pylon",
    description:
      "Data-driven dynasty fantasy football values with historical comps and market calibration.",
    // start_url MUST resolve to a 200 for Chrome's installability check.
    // The site is members-only, so "/" 307-redirects unauthenticated
    // visitors to /login — which is exactly what Chrome's headless
    // install-eligibility crawl experiences. That redirect was making
    // the install option disappear from Chrome's menu entirely.
    //
    // /login itself returns 200 for logged-out users and server-side
    // redirects logged-in users to /league, so installed launches
    // still land on a useful page either way without a client-side
    // bounce.
    start_url: "/login",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    categories: ["sports", "utilities"],
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
