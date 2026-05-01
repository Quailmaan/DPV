import Link from "next/link";

// Pro-tier passing profile card. QB equivalent of Rushing/Receiving
// profile cards. Plots the two metrics that lead the fantasy-points
// signal for quarterbacks:
//
//   - Passing EPA per dropback — the efficiency component the PYV
//     multiplier already uses. Trending it season-by-season makes
//     the multiplier's reasoning visible: rising = buy signal,
//     falling = sell signal even before raw fantasy points reflect it.
//
//   - Dropbacks (volume) — QB role consolidation indicator. A
//     starter losing dropbacks signals injury risk or coaching
//     committee thinking; a backup gaining dropbacks is a buy
//     candidate (Brock Purdy 2022, Bo Nix mid-2024). The PYV
//     opportunity score for QBs is hard-coded to 1.0, so without
//     this chart the volume signal is invisible in our existing UI.
//
// Free users see the section header + Pro upsell instead of the lines.

export interface PassingProfilePoint {
  season: number;
  epaPerDropback: number | null;
  dropbacks: number;
}

// ~3 starter games of dropbacks. Below this we render the dot faded
// so users don't read trend signal into a 60-dropback fill-in start.
// Same threshold as the PYV efficiency multiplier so chart and
// rankings agree on what counts as a real season.
const MIN_DROPBACKS = 100;

export default function PassingProfileCard({
  points,
  isPro,
}: {
  points: PassingProfilePoint[];
  isPro: boolean;
}) {
  // Hide entirely if no qualifying-sample season exists. Career
  // backups and never-started rookies have nothing meaningful to plot.
  const hasAnyEpa = points.some(
    (p) => p.epaPerDropback !== null && p.dropbacks >= MIN_DROPBACKS,
  );
  const hasAnyVolume = points.some((p) => p.dropbacks >= MIN_DROPBACKS);
  if (!hasAnyEpa && !hasAnyVolume) return null;

  return (
    <div className="mb-8 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
      <div className="flex items-baseline justify-between mb-1 flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Passing profile</h2>
        <span className="text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
          Pro
        </span>
      </div>
      <p className="text-sm text-zinc-500 mb-4">
        Per-dropback efficiency and total dropbacks by season. Volume
        leads the role-confidence signal —{" "}
        <strong>backups gaining dropbacks</strong> mid-season are
        breakout candidates (Brock Purdy &apos;22, Bo Nix &apos;24);{" "}
        <strong>starters losing them</strong> signal coaching doubt or
        injury before fantasy points catch up.
      </p>

      {isPro ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <MiniChart
            label="EPA per dropback"
            decimals={3}
            seasons={points.map((p) => ({
              season: p.season,
              value: p.dropbacks >= MIN_DROPBACKS ? p.epaPerDropback : null,
              faded: p.dropbacks < MIN_DROPBACKS,
            }))}
            // QBs sit roughly between -0.20 and +0.25 EPA per dropback.
            // Unlike RB rushing, QB EPA is structurally above zero
            // because most dropbacks include a positive-expected pass
            // attempt. Anchoring to this band keeps a "+0.10" elite
            // QB visually distinct from a "-0.05" struggling one.
            yMin={-0.25}
            yMax={0.3}
          />
          <MiniChart
            label="Dropbacks"
            decimals={0}
            seasons={points.map((p) => ({
              season: p.season,
              // Volume — show even on sub-threshold so a 60-dropback
              // backup season still appears (it IS the signal for
              // depth-chart placement). Faded handled separately.
              value: p.dropbacks > 0 ? p.dropbacks : null,
              faded: false,
            }))}
            // Full starter QB seasons land 550-700 dropbacks. Cap at
            // 750 so an outlier (e.g. Brady-era pass-heavy seasons)
            // still has headroom but median seasons aren't squashed.
            yMin={0}
            yMax={750}
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
        Spot QB role changes — backups breaking out, starters losing
        snaps — before the box score reflects it.
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

// Same minimal inline-SVG chart used in Rushing/ReceivingProfileCard.
// The two-direction labeled-decimal MiniChart is duplicated across
// the three position cards rather than abstracted into a shared
// module — each component has slightly different formatting and
// y-axis range needs, and the ~80 lines are simple enough that
// abstracting hurts readability more than it helps. Refactor only
// if a fourth position card lands.
function MiniChart({
  label,
  decimals,
  seasons,
  yMin,
  yMax,
}: {
  label: string;
  decimals: number;
  seasons: { season: number; value: number | null; faded: boolean }[];
  yMin: number;
  yMax: number;
}) {
  const W = 320;
  const H = 140;
  const PAD_L = 38;
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

  // Zero-line baseline for the EPA chart. QB rushing-style "below
  // expected" runs and sacks contribute negative EPA, so the line
  // makes net-positive QBs visually obvious.
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
