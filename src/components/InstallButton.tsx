"use client";

import { useCallback, useEffect, useState } from "react";

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
//   - Already installed (running as standalone PWA, or detected via
//     getInstalledRelatedApps): render nothing — the user clearly
//     doesn't need the button.
//   - Anywhere else (Firefox desktop, etc.): render nothing rather
//     than show a dead button.
//
// Dismissal is persisted in localStorage with a 30-day TTL so users
// who explicitly tap ✕ don't get nagged on every page load, but the
// option reappears if they change their mind a month later. The
// dismissal key is shared between the sheet and compact variants so
// dismissing on mobile also hides the desktop header link.

type InstallChoice = { outcome: "accepted" | "dismissed"; platform: string };
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<InstallChoice>;
};

type Variant = "sheet" | "compact";

// Persist user-initiated dismissals so we don't show the CTA every
// page load. After this much time we'll show again — gives users a
// way to rediscover the option without forcing them to dig through
// browser settings.
const DISMISS_KEY = "pylon:install-dismissed-at";
const DISMISS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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
  const [dismissed, setDismissed] = useState(false);

  // Read persisted dismissal on mount. Clears the entry if it's expired
  // so future "is it dismissed?" checks don't have to re-evaluate the
  // TTL. localStorage is wrapped in try/catch because Safari private
  // mode and some embedded webviews throw on access.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(DISMISS_KEY);
      if (!raw) return;
      const ts = parseInt(raw, 10);
      if (Number.isFinite(ts) && Date.now() - ts < DISMISS_TTL_MS) {
        setDismissed(true);
      } else {
        window.localStorage.removeItem(DISMISS_KEY);
      }
    } catch {
      // localStorage unavailable — treat as not dismissed, the worst
      // case is we show the CTA on a page that can't persist choice.
    }
  }, []);

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

    // Catch the case where the user installed Pylon via Chrome's own
    // ⋮-menu (not our button) and is now visiting in a regular tab.
    // getInstalledRelatedApps returns entries for installed PWAs whose
    // origin matches; if we find one, hide the CTA so we don't nag
    // someone who already has it. Chrome-only API; harmless if absent.
    type NavigatorWithGRA = Navigator & {
      getInstalledRelatedApps?: () => Promise<Array<{ platform?: string }>>;
    };
    const navWithGra = navigator as NavigatorWithGRA;
    if (typeof navWithGra.getInstalledRelatedApps === "function") {
      navWithGra
        .getInstalledRelatedApps()
        .then((apps) => {
          if (apps.length > 0) setInstalled(true);
        })
        .catch(() => {
          // Failure here isn't a problem — we just fall back to the
          // standalone-display-mode check above for hide logic.
        });
    }

    const onBip = (e: Event) => {
      // Suppress Chrome's own mini-info-bar. We're providing the UI.
      e.preventDefault();
      setBip(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setBip(null);
      // If they install, clear any prior dismissal so that an eventual
      // uninstall + reinstall flow shows the CTA again at the right time.
      try {
        window.localStorage.removeItem(DISMISS_KEY);
      } catch {
        /* ignore */
      }
    };

    window.addEventListener("beforeinstallprompt", onBip);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBip);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // localStorage unavailable — dismissal still applies for this
      // session via React state, just won't survive a reload.
    }
  }, []);

  // Hide if already installed or user explicitly dismissed.
  if (isStandalone || installed || dismissed) return null;

  // The "real" install path: browser handed us a prompt event.
  if (bip) {
    return (
      <InstallRow
        variant={variant}
        onInstall={async () => {
          await bip.prompt();
          const choice = await bip.userChoice;
          if (choice.outcome === "accepted") {
            // appinstalled handler will fire shortly after and hide us.
            setBip(null);
          }
          // If dismissed at the OS dialog, leave bip in place so they
          // can change their mind. Our own ✕ is the persistent dismiss.
        }}
        onDismiss={dismiss}
      />
    );
  }

  // iOS Safari: no programmatic install. Show a button that toggles
  // a small instruction panel.
  if (isIos) {
    return (
      <div className="w-full">
        <InstallRow
          variant={variant}
          onInstall={() => setShowIosHelp((v) => !v)}
          onDismiss={dismiss}
        />
        {showIosHelp && <IosInstructions />}
      </div>
    );
  }

  // Other browsers (Firefox desktop, Safari macOS, etc.) — no install
  // path, render nothing rather than a dead button.
  return null;
}

// One layout row: the install action button + a small ✕ to dismiss.
// On the sheet variant the install button is a full-width emerald CTA
// with the ✕ floating to its right; on the compact variant the install
// link is inline text and the ✕ sits next to it.
function InstallRow({
  variant,
  onInstall,
  onDismiss,
}: {
  variant: Variant;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (variant === "compact") {
    return (
      <span className="hidden sm:inline-flex items-center gap-1">
        <button
          type="button"
          onClick={onInstall}
          className="inline-flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          <DownloadIcon className="h-4 w-4" />
          Install
        </button>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss install prompt"
          title="Don&rsquo;t show this for 30 days"
          className="inline-flex items-center justify-center w-5 h-5 rounded text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </span>
    );
  }
  return (
    <div className="flex items-stretch gap-2 mt-2">
      <button
        type="button"
        onClick={onInstall}
        className="flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white text-sm font-medium px-4 py-2.5"
      >
        <DownloadIcon className="h-4 w-4" />
        Install Pylon app
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss install prompt"
        title="Don&rsquo;t show this for 30 days"
        className="inline-flex items-center justify-center w-10 rounded-md border border-zinc-200 dark:border-zinc-800 text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700"
      >
        <XIcon className="h-4 w-4" />
      </button>
    </div>
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

function XIcon({ className }: { className?: string }) {
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
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
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
