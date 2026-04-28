import type { SellWindow } from "@/lib/dpv/sellWindow";

// Compact pill rendering of a sell-window verdict. Used on player
// pages and the league roster view. The reason is exposed via `title`
// so power users see the rationale on hover.
//
// Free users get a "blurred" variant — label hidden behind a generic
// "Pro signal" tag with the upgrade pitch. Keeps the column meaningful
// (visual signal that *something* is there) without giving away the
// data.
export default function SellWindowBadge({
  sw,
  isPro,
  size = "sm",
}: {
  sw: SellWindow;
  isPro: boolean;
  size?: "xs" | "sm";
}) {
  if (!isPro) {
    return (
      <span
        title="Upgrade to Pro to see sell-window verdicts"
        className={`inline-flex items-center gap-1 font-medium rounded ${
          size === "xs" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5"
        } bg-zinc-100 text-zinc-400 dark:bg-zinc-800 dark:text-zinc-500`}
      >
        <svg
          className="h-3 w-3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>Pro</span>
      </span>
    );
  }

  const cls: Record<SellWindow["tone"], string> = {
    bad: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
    warn:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    neutral:
      "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    good: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
    elite:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  };

  return (
    <span
      title={sw.reason}
      className={`inline-flex items-center font-medium rounded ${
        size === "xs" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5"
      } ${cls[sw.tone]} whitespace-nowrap`}
    >
      {sw.label}
    </span>
  );
}
