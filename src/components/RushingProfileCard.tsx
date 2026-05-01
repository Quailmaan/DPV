import Link from "next/link";

// Pro-tier rushing profile card. RB equivalent of ReceivingProfileCard.
// Plots two metrics that lead the fantasy-points signal for running
// backs:
//
//   - Rushing EPA per carry — the efficiency component the PYV
//     multiplier already uses. Trending it season-by-season makes
//     the multiplier's reasoning visible: a rising line is a buy
//     signal, falling is a sell signal even if raw fantasy points
//     haven't moved yet.
//
//   - Carries (volume) — RBs' single best aging indicator. Older
//     backs lose carries to committee timeshares before they lose
//     yards-per-carry. A dropping carries trend in a 27-year-old
//     is the canonical "sell now" pattern, and the PYV opportunity
//     score lags this by months because it averages season totals.
//
// Free users see the section header + Pro upsell instead of the lines,
// matching the ReceivingProfileCard pattern.

export interface RushingProfilePoint {
  season: number;
  epaPerCarry: number | null;
  carries: number;
}

// ~3 starter games. Below this we render the dot faded so users don't
// read trend signal into a 12-carry change-of-pace appearance. Same
// threshold as the PYV efficiency multiplier so the chart and the
// underlying ranking agree on "does this season count?"
const MIN_CARRIES = 50;

export default function RushingProfileCard({
  points,
  isPro,
}: {
  points: RushingProfilePoint[];
  isPro: boolean;
}) {
  // Hide the section if there's no qualifying-sample season. A
  // never-played rookie, or a deep-bench RB who's never cleared 50
  // carries, has no rushing profile to plot.
  const hasAnyEpa = points.some(
    (p) => p.epaPerCarry !== null && p.carries >= MIN_CARRIES,
  );
  const hasAnyCarries = points.some((p) => p.carries >= MIN_CARRIES);
  if (!hasAnyEpa && !hasAnyCarries) return null;

  return (
    <div className="mb-8 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Rushing profile</h2>
        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
          Pro
        </span>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Per-carry efficiency and total carries by season. Aging RBs{" "}
        <strong>lose carries before they lose YPC</strong>, so the volume
        line leads the sell signal by months. Rising carries + rising
        EPA = breakout candidate; both falling = the committee has moved on.
      </p>

      {isPro ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MiniChart
            label="EPA per carry"
            unit=""
            decimals={3}
            seasons={points.map((p) => ({
              season: p.season,
              value: p.carries >= MIN_CARRIES ? p.epaPerCarry : null,
              faded: p.carries < MIN_CARRIES,
            }))}
            // RBs sit roughly between -0.25 and +0.10 EPA per carry —
            // rushing is structurally below-zero EPA because a 3-yard
            // gain on 1st-and-10 is "expected" rather than positive.
            // Anchoring axes here keeps a "+0.05" elite season visually
            // distinct from a "-0.15" struggle season.
            yMin={-0.25}
            yMax={0.15}
          />
          <MiniChart
            label="Carries"
            unit=""
            decimals={0}
            seasons={points.map((p) => ({
              season: p.season,
              // Volume metric — show even on sub-threshold seasons since
              // a 30-carry season IS the signal (early-career or aging
              // out). Faded only when literally zero, which we surface
              // as null below.
              value: p.carries > 0 ? p.carries : null,
              faded: false,
            }))}
            // Workhorse RBs land in the 250-330 range; bell-cow seasons
            // push 350+. Cap at 380 so a Henry-style outlier still has
            // headroom but the Y-axis doesn't squash median seasons.
            yMin={0}
            yMax={380}
          />
        </div>
      ) : (
        <ProTeaser />
      )}
    </div>
  );
}

function ProTeaser() {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 p-5 text-center">
      <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1">
        Sell-window indicators are part of Pylon Pro.
      </p>
      <p className="text-xs text-zinc-500 mb-4">
        Spot RB committee shifts and aging-out signals before fantasy points
        catch up.
      </p>
      <Link
        href="/pricing"
        className="inline-flex items-center text-sm font-medium px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 text-white"
      >
        See Pro features — $7/mo
      </Link>
    </div>
  );
}

// Same minimal inline-SVG chart as ReceivingProfileCard.MiniChart.
// Duplicated here rather than abstracted into a shared module because
// the two components have slightly different decimal-formatting and
// y-axis range needs, and the ~80 lines are simple enough that
// abstracting hurts readability more than it helps.
function MiniChart({
  label,
  unit,
  decimals,
  seasons,
  yMin,
  yMax,
}: {
  label: string;
  unit: string;
  decimals: number;
  seasons: { season: number; value: number | null; faded: boolean }[];
  yMin: number;
  yMax: number;
}) {
  const W = 320;
  const H = 140;
  const PAD_L = 38; // wider for "−0.250"-style labels
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 24;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;

  const validSeasons = seasons.filter((s) => s.value !== null);
  if (validSeasons.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
        <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500 mb-2">
          {label}
        </div>
        <div className="text-xs text-zinc-400 italic">No qualifying seasons</div>
      </div>
    );
  }

  const xStep = seasons.length > 1 ? plotW / (seasons.length - 1) : 0;
  const xFor = (i: number) =>
    seasons.length === 1 ? PAD_L + plotW / 2 : PAD_L + i * xStep;
  const yFor = (v: number) => {
    const clamped = Math.max(yMin, Math.min(yMax, v));
    const t = (clamped - yMin) / (yMax - yMin);
    return PAD_T + plotH * (1 - t);
  };

  const segments: string[] = [];
  let currentSeg: string[] = [];
  seasons.forEach((s, i) => {
    if (s.value === null) {
      if (currentSeg.length > 0) segments.push(currentSeg.join(" "));
      currentSeg = [];
      return;
    }
    const cmd = currentSeg.length === 0 ? "M" : "L";
    currentSeg.push(`${cmd}${xFor(i).toFixed(1)},${yFor(s.value).toFixed(1)}`);
  });
  if (currentSeg.length > 0) segments.push(currentSeg.join(" "));

  const latest = [...validSeasons].sort((a, b) => b.season - a.season)[0];

  // For the EPA chart, also draw a zero-line so users see at-a-glance
  // whether the player's runs are net-positive or net-negative EPA.
  // Only draw it when 0 is inside [yMin, yMax].
  const showZero = yMin <= 0 && yMax >= 0;
  const zeroY = showZero ? yFor(0) : null;

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500">
          {label}
        </div>
        <div className="text-sm tabular-nums font-medium">
          {latest.value!.toFixed(decimals)}
          {unit ? <span className="text-zinc-400 text-xs">{unit}</span> : null}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`${label} per season`}
      >
        {[0.25, 0.5, 0.75].map((t) => {
          const y = PAD_T + plotH * t;
          return (
            <line
              key={t}
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity="0.08"
              strokeDasharray="2 3"
            />
          );
        })}
        {/* Zero baseline for EPA — emphasize positive vs negative. */}
        {zeroY !== null && (
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={zeroY}
            y2={zeroY}
            stroke="currentColor"
            strokeOpacity="0.25"
            strokeWidth="1"
          />
        )}
        <text
          x={PAD_L - 4}
          y={PAD_T + 4}
          textAnchor="end"
          className="fill-zinc-400 text-[10px]"
        >
          {yMax.toFixed(decimals)}
        </text>
        <text
          x={PAD_L - 4}
          y={PAD_T + plotH}
          textAnchor="end"
          className="fill-zinc-400 text-[10px]"
        >
          {yMin.toFixed(decimals)}
        </text>
        {segments.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-emerald-600 dark:text-emerald-400"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {seasons.map((s, i) => {
          if (s.value === null) return null;
          return (
            <circle
              key={s.season}
              cx={xFor(i)}
              cy={yFor(s.value)}
              r="3"
              className={
                s.faded
                  ? "fill-zinc-300 dark:fill-zinc-700"
                  : "fill-emerald-600 dark:fill-emerald-400"
              }
            />
          );
        })}
        {seasons.map((s, i) => (
          <text
            key={s.season}
            x={xFor(i)}
            y={H - 6}
            textAnchor="middle"
            className="fill-zinc-500 text-[10px]"
          >
            {s.season}
          </text>
        ))}
      </svg>
    </div>
  );
}
