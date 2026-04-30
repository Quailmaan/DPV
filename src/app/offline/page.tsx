import Link from "next/link";

// Offline fallback — served by the service worker (public/sw.js) when
// a navigation request fails because the device has no network. Kept
// deliberately minimal: no data fetches, just a heading and a retry
// link. Once the user is back online, hitting "Try again" lets the SW
// pass the navigation through to the network and they're back.
export const dynamic = "force-static";

export const metadata = {
  title: "Offline · Pylon",
};

export default function OfflinePage() {
  return (
    <div className="mx-auto max-w-md text-center py-16">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">
        You&apos;re offline
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        Pylon needs a network connection to pull the latest rankings,
        league data, and market values. Reconnect and try again.
      </p>
      <Link
        href="/"
        className="inline-flex items-center rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2 text-sm font-medium hover:bg-zinc-50 dark:hover:bg-zinc-800 active:bg-zinc-100 dark:active:bg-zinc-700"
      >
        Try again
      </Link>
    </div>
  );
}
