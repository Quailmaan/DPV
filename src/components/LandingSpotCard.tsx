import {
  type LandingSpotBullet,
  summarizeLandingSpot,
} from "@/lib/dpv/landingSpot";

const TONE_DOT: Record<LandingSpotBullet["tone"], string> = {
  pro: "bg-emerald-500",
  con: "bg-rose-500",
  neutral: "bg-zinc-400 dark:bg-zinc-500",
};

const TONE_PILL: Record<LandingSpotBullet["tone"], string> = {
  pro: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200",
  con: "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-200",
  neutral:
    "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300",
};

export default function LandingSpotCard({
  bullets,
  team,
  position,
  /** Cap how many bullets render (sorted by weight desc). */
  limit = 6,
}: {
  bullets: LandingSpotBullet[];
  team: string | null;
  position: string;
  limit?: number;
}) {
  if (bullets.length === 0) return null;

  const sorted = [...bullets].sort((a, b) => b.weight - a.weight).slice(0, limit);
  const summary = summarizeLandingSpot(bullets);

  return (
    <div className="mb-8">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
        <h2 className="text-lg font-semibold">Landing Spot</h2>
        <div className="text-xs text-zinc-500">
          Pros &amp; cons of {position} on {team ?? "—"} based on capital, depth,
          O-line, QB, age
        </div>
      </div>
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
        {summary && (
          <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between flex-wrap gap-2">
            <div className="text-sm text-zinc-600 dark:text-zinc-400">
              Net read on the situation:
            </div>
            <span
              className={`text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded border ${TONE_PILL[summary.tone]}`}
            >
              {summary.label}
            </span>
          </div>
        )}
        <ul>
          {sorted.map((b, i) => (
            <li
              key={`${b.title}-${i}`}
              className="px-4 py-3 border-t border-zinc-100 dark:border-zinc-800 first:border-t-0 flex gap-3"
            >
              <span
                className={`mt-1.5 h-2 w-2 rounded-full flex-shrink-0 ${TONE_DOT[b.tone]}`}
                aria-hidden
              />
              <div className="min-w-0">
                <div className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                  {b.title}
                  <span
                    className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${TONE_PILL[b.tone]}`}
                  >
                    {b.tone === "pro"
                      ? "Pro"
                      : b.tone === "con"
                        ? "Con"
                        : "Neutral"}
                  </span>
                </div>
                <div className="text-sm text-zinc-500 mt-0.5">{b.detail}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
