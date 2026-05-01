import Link from "next/link";

// Pro-tier receiving profile card. Plots aDOT and YAC-per-reception
// over the player's last few seasons. Both metrics are leading
// indicators of dynasty value decline (or breakout) that show up
// before raw fantasy points do — aDOT contracting means the team is
// using the WR as a possession option (ceiling cap), and dropping
// YAC means the WR is losing the breakaway gear.
//
// Free users get a teaser: chart axes + locked overlay + "what this
// would tell you" copy. The actual lines render only when isPro is true.
//
// Server Component on purpose — purely presentational, no interactivity,
// no JS bundle cost.

export interface ReceivingProfilePoint {
  season: number;
  adot: number | null;
  yacPerReception: number | null;
  // Sample sizes — points below the threshold draw as faded so users
  // know not to read trend signal into a 12-target year.
  targets: number;
  receptions: number;
}

const MIN_TARGETS = 30;
const MIN_RECEPTIONS = 15;

export default function ReceivingProfileCard({
  points,
  isPro,
}: {
  points: ReceivingProfilePoint[];
  isPro: boolean;
}) {
  // Hide the section entirely if there's no historical data — a
  // never-played-rookie can't have a receiving profile yet, and showing
  // an empty card is worse than skipping it.
  const hasAnyAdot = points.some(
    (p) => p.adot !== null && p.targets >= MIN_TARGETS,
  );
  const hasAnyYac = points.some(
    (p) => p.yacPerReception !== null && p.receptions >= MIN_RECEPTIONS,
  );
  if (!hasAnyAdot && !hasAnyYac) return null;

  return (
    <div className="mb-8 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Receiving profile</h2>
        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
          Pro
        </span>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Average depth of target and yards-after-catch trends. Both lead
        the fantasy-points signal by months — <strong>contracting aDOT</strong>{" "}
        means a possession-option role taking shape;{" "}
        <strong>dropping YAC</strong> means the breakaway gear is gone.
      </p>

      {isPro ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MiniChart
            label="aDOT"
            unit=" yds"
            seasons={points.map((p) => ({
              season: p.season,
              value: p.targets >= MIN_TARGETS ? p.adot : null,
              faded: p.targets < MIN_TARGETS,
            }))}
            // aDOT range bands: Pylon's WR distribution sits roughly
            // between 6 and 14 yards. Anchoring axes to the league-wide
            // band keeps the same chart shape across players (a 12-yard
            // deep threat vs a 7-yard slot reads visually distinct).
            yMin={4}
            yMax={16}
          />
          <MiniChart
            label="YAC per reception"
            unit=" yds"
            seasons={points.map((p) => ({
              season: p.season,
              value: p.receptions >= MIN_RECEPTIONS ? p.yacPerReception : null,
              faded: p.receptions < MIN_RECEPTIONS,
            }))}
            // YAC range — most WR/TE land between 2 and 8 YAC/rec.
            yMin={1}
            yMax={9}
          />
        </div>
      ) : (
        <ProTeaser />
      )}
    </div>
  );
}

// Pro upsell shown to free users. We could blur a real chart instead,
// but the data ingest pipeline is the same regardless of tier — gating
// here is purely a product decision, not a load-time concern. Static
// placeholder is cheaper and honest.
function ProTeaser() {
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60 p-5 text-center">
      <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-1">
        Sell-window indicators are part of Pylon Pro.
      </p>
      <p className="text-xs text-zinc-500 mb-4">
        Spot role contraction and aging before it shows up in the box score.
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

// Tiny inline-SVG line chart. We deliberately avoid a charting library
// because the project's other small charts (PyvTrendChart) follow the
// same pattern and we'd rather match the bundle/styling than introduce
// recharts/visx for a 200×120 viz.
function MiniChart({
  label,
  unit,
  seasons,
  yMin,
  yMax,
}: {
  label: string;
  unit: string;
  seasons: { season: number; value: number | null; faded: boolean }[];
  yMin: number;
  yMax: number;
}) {
  const W = 320;
  const H = 140;
  const PAD_L = 32; // room for y-axis labels
  const PAD_R = 8;
  const PAD_T = 12;
  const PAD_B = 24; // room for season labels
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

  // X-axis: spread evenly across plot area. Y-axis: linear scale
  // anchored to the league-wide bands (passed in as yMin/yMax).
  const xStep = seasons.length > 1 ? plotW / (seasons.length - 1) : 0;
  const xFor = (i: number) =>
    seasons.length === 1 ? PAD_L + plotW / 2 : PAD_L + i * xStep;
  const yFor = (v: number) => {
    const clamped = Math.max(yMin, Math.min(yMax, v));
    const t = (clamped - yMin) / (yMax - yMin);
    return PAD_T + plotH * (1 - t);
  };

  // Build the line path, but skip null points so a single missing
  // season doesn't draw a line through the gap.
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

  // Most recent valid value goes in the top-right summary text.
  const latest = [...validSeasons].sort((a, b) => b.season - a.season)[0];

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 p-3">
      <div className="flex items-baseline justify-between mb-1">
        <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500">
          {label}
        </div>
        <div className="text-sm tabular-nums font-medium">
          {latest.value!.toFixed(1)}
          <span className="text-zinc-400 text-xs">{unit}</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto"
        role="img"
        aria-label={`${label} per season`}
      >
        {/* Subtle horizontal gridlines at 25/50/75% to anchor the eye. */}
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
        {/* Y-axis labels: just min/max so the chart stays readable. */}
        <text
          x={PAD_L - 4}
          y={PAD_T + 4}
          textAnchor="end"
          className="fill-zinc-400 text-[10px]"
        >
          {yMax}
        </text>
        <text
          x={PAD_L - 4}
          y={PAD_T + plotH}
          textAnchor="end"
          className="fill-zinc-400 text-[10px]"
        >
          {yMin}
        </text>
        {/* Line(s) — split into segments to skip null gaps. */}
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
        {/* Data points. Faded for sub-threshold sample sizes. */}
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
        {/* X-axis: season labels under each point. */}
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
