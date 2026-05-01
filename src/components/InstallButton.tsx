"use client";

import { useEffect, useState } from "react";

// In-app "Install Pylon" button. Browsers do not surface their own
// install prompt aggressively — Chrome hides the option behind a small
// URL-bar icon and a buried ⋮-menu entry, and iOS Safari has no prompt
// at all. Most users never find it. This component gives us a visible
// CTA inside the Pylon UI that triggers the native install dialog,
// or shows iOS users the manual Share-menu instructions.
//
// Behavior by platform:
//   - Chrome / Edge / Android Chrome: when the browser fires
//     `beforeinstallprompt` (i.e. it considers the site installable),
//     we stash the event and render a button. Clicking it calls
//     event.prompt() which surfaces Chrome's native install dialog.
//   - iOS Safari: `beforeinstallprompt` never fires (Apple restriction).
//     We detect iOS and show a "How to install" inline panel that walks
//     through Share → Add to Home Screen.
//   - Already installed (running as standalone PWA): render nothing —
//     the user clearly doesn't need the button.
//   - Anywhere else (Firefox desktop, etc.): render nothing rather
//     than show a dead button.
//
// We don't persist a "user dismissed" flag yet — the browser's own
// `userChoice` outcome is enough; if they decline, the button stays
// visible so they can change their mind.

type InstallChoice = { outcome: "accepted" | "dismissed"; platform: string };
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
};

type Variant = "sheet" | "compact";

export default function InstallButton({
  variant = "sheet",
}: {
  variant?: Variant;
}) {
  // The Chrome-fired install event, stashed so we can call .prompt()
  // on user click. null means either the event hasn't fired yet, the
  // platform doesn't support it, or the user already accepted.
  const [bip, setBip] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isStandalone, setIsStandalone] = useState(false);
  const [isIos, setIsIos] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // matchMedia is the standard way; navigator.standalone is the iOS-
    // specific fallback. Either being true means we're already
    // launched as an installed PWA, so the button is moot.
    const standaloneMq = window.matchMedia("(display-mode: standalone)");
    const iosStandalone =
      "standalone" in navigator &&
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setIsStandalone(standaloneMq.matches || iosStandalone);

    // iOS detection — UA-sniff is unreliable in general but the install
    // story on iOS is platform-specific enough that we accept the
    // false-positive risk on iPad-disguised-as-Mac. The fallback
    // (showing iOS instructions to a Mac user) is harmless.
    const ua = navigator.userAgent;
    const ios =
      /iPad|iPhone|iPod/i.test(ua) ||
      // iPadOS 13+ identifies as Mac but has touch — this catches it.
      (ua.includes("Mac") && "ontouchend" in document);
    setIsIos(ios);

    const onBip = (e: Event) => {
      // Suppress Chrome's own mini-info-bar. We're providing the UI.
      e.preventDefault();
      setBip(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setBip(null);
    };

    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Already an installed PWA — nothing to do.
  if (isStandalone || installed) return null;

  // The "real" install path: browser handed us a prompt event.
  if (bip) {
    return (
      <PromptButton
        variant={variant}
        onClick={async () => {
          await bip.prompt();
          const choice = await bip.userChoice;
          if (choice.outcome === "accepted") {
            // appinstalled handler will fire shortly after.
            setBip(null);
          }
          // If dismissed, leave bip in place so they can try again.
        }}
      />
    );
  }

  // iOS Safari: no programmatic install. Show a button that toggles
  // a small instruction panel.
  if (isIos) {
    return (
      <div className="w-full">
        <PromptButton
          variant={variant}
          onClick={() => setShowIosHelp((v) => !v)}
        />
        {showIosHelp && <IosInstructions />}
      </div>
    );
  }

  // Other browsers (Firefox desktop, Safari macOS, etc.) — no install
  // path, render nothing rather than a dead button.
  return null;
}

// Button styles vary slightly by surface: the mobile sheet wants a
// full-width emerald CTA; the desktop header wants a subtle inline link.
function PromptButton({
  variant,
  onClick,
}: {
  variant: Variant;
  onClick: () => void;
}) {
  if (variant === "compact") {
    return (
      <button
        type="button"
        onClick={onClick}
        className="hidden sm:inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        <DownloadIcon className="h-4 w-4" />
        Install
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium px-4 py-2.5 mt-2"
    >
      <DownloadIcon className="h-4 w-4" />
      Install Pylon app
    </button>
  );
}

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

// iOS-specific install instructions. The Share button on iOS Safari
// is the only path to "Add to Home Screen" — there is no JS API.
// Calling out that it must be Safari (not Chrome on iOS) is critical:
// every browser on iOS uses WebKit but only Safari exposes the install
// option in its share sheet.
function IosInstructions() {
  return (
    <div className="mt-2 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-3 text-xs text-zinc-700 dark:text-zinc-300 space-y-1.5">
      <div className="font-medium text-zinc-900 dark:text-zinc-100">
        Install on iPhone / iPad
      </div>
      <div>
        1. Open this site in <strong>Safari</strong> (not Chrome — iOS only
        allows installs from Safari).
      </div>
      <div>
        2. Tap the <strong>Share</strong> button at the bottom of the screen
        (square with an up-arrow).
      </div>
      <div>
        3. Scroll the share sheet and tap{" "}
        <strong>&ldquo;Add to Home Screen&rdquo;</strong>.
      </div>
      <div>4. Tap &ldquo;Add&rdquo; in the top right.</div>
    </div>
  );
}
