"use client";

import { useMemo, useState } from "react";

// Inline SVG line chart for a player's PYV history. We render this
// instead of pulling in Recharts because it's one chart shape, the
// styling needs to match the zinc/emerald palette already used on the
// player page, and the bundle savings are real on a route that loads
// on every player click.
//
// Behavior:
//   - Single line over a fixed-aspect SVG, padded for axis labels.
//   - 4 horizontal grid lines + Y-axis tick labels (DPV scale).
//   - First / last / current X-axis labels (date range).
//   - Hover anywhere on the chart snaps the crosshair to the nearest
//     data point and shows a small tooltip card. Touch users tap to
//     pin, tap elsewhere to dismiss.
//   - Range toggle (30D / 6M / 1Y / All) stays client-side; we get the
//     full series from the parent and just slice it locally.

export type TrendPoint = {
  date: string; // YYYY-MM-DD, ascending order
  dpv: number;
};

type Range = "30D" | "6M" | "1Y" | "ALL";

const RANGES: { key: Range; label: string; days: number | null }[] = [
  { key: "30D", label: "30D", days: 30 },
  { key: "6M", label: "6M", days: 180 },
  { key: "1Y", label: "1Y", days: 365 },
  { key: "ALL", label: "All", days: null },
];

// Chart geometry, in SVG units. The viewBox makes everything responsive
// — the parent picks the actual rendered size via CSS width.
const W = 720;
const H = 240;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 28;

function formatDate(iso: string): string {
  // "2026-04-15" → "Apr 15". Stays compact under hover.
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDateLong(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function PyvTrendChart({
  points,
  positionLabel,
}: {
  points: TrendPoint[];
  /** Used in the empty state so it reads "No PYV history yet for this WR" etc. */
  positionLabel?: string;
}) {
  const [range, setRange] = useState<Range>("ALL");
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Slice to the active range. We expect `points` to be ascending by
  // date — slice from the end so "30D" = last 30 days.
  const visible = useMemo(() => {
    const cfg = RANGES.find((r) => r.key === range);
    if (!cfg || cfg.days === null) return points;
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - cfg.days);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return points.filter((p) => p.date >= cutoffIso);
  }, [points, range]);

  // Empty / single-point states. A single point is technically a chart
  // but a "line" needs ≥2; we render a hint instead.
  if (visible.length < 2) {
    return (
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-sm text-zinc-500">
        {points.length === 0 ? (
          <>
            No PYV history yet{positionLabel ? ` for this ${positionLabel}` : ""}.{" "}
            <span className="text-zinc-700 dark:text-zinc-300">
              The line will appear once we have ≥ 2 daily snapshots.
            </span>
          </>
        ) : (
          <>
            Not enough data in this range — try a wider window.
            <RangeToggle range={range} setRange={setRange} />
          </>
        )}
      </div>
    );
  }

  // Y scale: pad the min/max by ~5% so the line doesn't kiss the edges.
  // Use a floor of 0 — DPV is always non-negative.
  const dpvs = visible.map((p) => p.dpv);
  const rawMin = Math.min(...dpvs);
  const rawMax = Math.max(...dpvs);
  const span = Math.max(1, rawMax - rawMin);
  const yMin = Math.max(0, Math.floor(rawMin - span * 0.08));
  const yMax = Math.ceil(rawMax + span * 0.08);

  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  const xFor = (i: number) =>
    PAD_LEFT + (visible.length === 1 ? innerW / 2 : (i / (visible.length - 1)) * innerW);
  const yFor = (v: number) =>
    PAD_TOP + innerH - ((v - yMin) / (yMax - yMin)) * innerH;

  // Build the polyline path.
  const pathD = visible
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(2)} ${yFor(p.dpv).toFixed(2)}`)
    .join(" ");

  // Filled area under the line — adds visual weight without a second color.
  const areaD =
    pathD +
    ` L ${xFor(visible.length - 1).toFixed(2)} ${(PAD_TOP + innerH).toFixed(2)}` +
    ` L ${xFor(0).toFixed(2)} ${(PAD_TOP + innerH).toFixed(2)} Z`;

  // Y-axis ticks: 4 evenly spaced values between yMin and yMax.
  const yTicks = [0, 1, 2, 3, 4].map(
    (i) => yMin + ((yMax - yMin) * i) / 4,
  );

  // Color the line by net direction: emerald if up over the visible
  // window, red if down, neutral if flat. Same convention as the
  // delta column on the rankings table.
  const netDelta = visible[visible.length - 1].dpv - visible[0].dpv;
  const lineColor =
    netDelta > 0
      ? "rgb(16 185 129)" // emerald-500
      : netDelta < 0
      ? "rgb(239 68 68)" // red-500
      : "rgb(113 113 122)"; // zinc-500

  // Map an X coord (in SVG units) to the nearest visible point index.
  function nearestIndex(svgX: number): number {
    if (visible.length === 0) return 0;
    if (svgX <= PAD_LEFT) return 0;
    if (svgX >= PAD_LEFT + innerW) return visible.length - 1;
    const ratio = (svgX - PAD_LEFT) / innerW;
    return Math.round(ratio * (visible.length - 1));
  }

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * W;
    setHoverIdx(nearestIndex(x));
  }

  const hover = hoverIdx !== null ? visible[hoverIdx] : null;

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <div className="text-sm font-medium">PYV trend</div>
          <div className="text-xs text-zinc-500">
            {formatDateLong(visible[0].date)} → {formatDateLong(visible[visible.length - 1].date)}
            <span
              className={`ml-2 font-medium ${
                netDelta > 0
                  ? "text-emerald-600 dark:text-emerald-400"
                  : netDelta < 0
                  ? "text-red-600 dark:text-red-400"
                  : "text-zinc-500"
              }`}
            >
              {netDelta > 0 ? "+" : ""}
              {netDelta} ({percentChangeLabel(visible[0].dpv, visible[visible.length - 1].dpv)})
            </span>
          </div>
        </div>
        <RangeToggle range={range} setRange={setRange} />
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full h-auto"
          onMouseMove={handleMove}
          onMouseLeave={() => setHoverIdx(null)}
          role="img"
          aria-label="PYV trend over time"
        >
          {/* Y grid lines + labels */}
          {yTicks.map((v) => {
            const y = yFor(v);
            return (
              <g key={v}>
                <line
                  x1={PAD_LEFT}
                  x2={W - PAD_RIGHT}
                  y1={y}
                  y2={y}
                  className="stroke-zinc-100 dark:stroke-zinc-800"
                  strokeWidth={1}
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-zinc-400 dark:fill-zinc-500 text-[10px] tabular-nums"
                >
                  {Math.round(v)}
                </text>
              </g>
            );
          })}

          {/* X-axis date labels — first, mid, last */}
          {[0, Math.floor(visible.length / 2), visible.length - 1].map((i, k) => (
            <text
              key={`xtick-${k}`}
              x={xFor(i)}
              y={H - 8}
              textAnchor={k === 0 ? "start" : k === 2 ? "end" : "middle"}
              className="fill-zinc-400 dark:fill-zinc-500 text-[10px]"
            >
              {formatDate(visible[i].date)}
            </text>
          ))}

          {/* Filled area below the line */}
          <path d={areaD} fill={lineColor} fillOpacity={0.08} />

          {/* The line itself */}
          <path
            d={pathD}
            fill="none"
            stroke={lineColor}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Hover crosshair + dot */}
          {hover && hoverIdx !== null && (
            <g>
              <line
                x1={xFor(hoverIdx)}
                x2={xFor(hoverIdx)}
                y1={PAD_TOP}
                y2={PAD_TOP + innerH}
                className="stroke-zinc-300 dark:stroke-zinc-700"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <circle
                cx={xFor(hoverIdx)}
                cy={yFor(hover.dpv)}
                r={4}
                fill={lineColor}
                stroke="white"
                strokeWidth={2}
                className="dark:stroke-zinc-900"
              />
            </g>
          )}
        </svg>

        {/* Tooltip — absolutely positioned over the SVG. We place it on
            the side opposite the hover so it doesn't get clipped at
            either edge. */}
        {hover && hoverIdx !== null && (
          <div
            className="pointer-events-none absolute top-1 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white/95 dark:bg-zinc-900/95 backdrop-blur px-2.5 py-1.5 text-xs shadow-sm"
            style={{
              left:
                hoverIdx > visible.length / 2 ? `${(PAD_LEFT / W) * 100}%` : undefined,
              right:
                hoverIdx <= visible.length / 2
                  ? `${(PAD_RIGHT / W) * 100}%`
                  : undefined,
            }}
          >
            <div className="text-zinc-500">{formatDateLong(hover.date)}</div>
            <div className="font-semibold tabular-nums">PYV {hover.dpv}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function RangeToggle({
  range,
  setRange,
}: {
  range: Range;
  setRange: (r: Range) => void;
}) {
  return (
    <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-xs">
      {RANGES.map((r) => (
        <button
          key={r.key}
          type="button"
          onClick={() => setRange(r.key)}
          className={`px-2 py-1 ${
            range === r.key
              ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
              : "hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-600 dark:text-zinc-400"
          }`}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function percentChangeLabel(from: number, to: number): string {
  if (from === 0) return "—";
  const pct = ((to - from) / from) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}
