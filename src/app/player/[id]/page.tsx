import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import type { DPVBreakdown } from "@/lib/dpv/types";
import type { ScoringFormat } from "@/lib/dpv/types";

const FORMATS: { key: ScoringFormat; label: string }[] = [
  { key: "STANDARD", label: "Standard" },
  { key: "HALF_PPR", label: "Half PPR" },
  { key: "FULL_PPR", label: "Full PPR" },
];

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

function ageFromBirth(bd: string | null): number | null {
  if (!bd) return null;
  return (
    (Date.now() - new Date(bd).getTime()) /
    (365.25 * 24 * 3600 * 1000)
  );
}

// Per-position PPG bands. QBs score in a different universe (pass TDs + yards),
// TEs peak lower than WRs, RB and WR split since PPR shifts WR PPG up.
function bpsLabel(position: string, ppg: number): string {
  const bands: Record<string, [number, number, number]> = {
    QB: [22, 18, 14],
    RB: [16, 13, 9],
    WR: [14, 11, 7.5],
    TE: [12, 9, 6],
  };
  const [elite, strong, solid] = bands[position] ?? bands.WR;
  if (ppg >= elite) return "Elite producer";
  if (ppg >= strong) return "Strong producer";
  if (ppg >= solid) return "Solid producer";
  return "Low producer";
}

function ageModifierLabel(v: number): string {
  if (v >= 1.15) return "Ascending";
  if (v >= 1.05) return "In prime";
  if (v >= 0.95) return "Mature";
  if (v >= 0.85) return "Aging";
  return "Late career";
}

// Opportunity score is a 0-1 blend of snap + touch + vacancy. Numeric bands
// stay constant but labels describe what that score means for the position —
// a 0.7 opportunity score is a workhorse RB but an alpha WR.
function opportunityLabel(position: string, v: number): string {
  if (position === "RB") {
    if (v >= 0.7) return "Workhorse role";
    if (v >= 0.5) return "High volume";
    if (v >= 0.35) return "Committee lead";
    if (v >= 0.2) return "Rotational";
    return "Limited touches";
  }
  if (position === "TE") {
    if (v >= 0.7) return "Elite target";
    if (v >= 0.5) return "Primary target";
    if (v >= 0.35) return "Involved";
    if (v >= 0.2) return "Secondary role";
    return "Limited targets";
  }
  // WR (default)
  if (v >= 0.7) return "Alpha target";
  if (v >= 0.5) return "Primary target";
  if (v >= 0.35) return "Secondary target";
  if (v >= 0.2) return "Rotational";
  return "Limited targets";
}

function olineLabel(v: number): string {
  if (v >= 1.1) return "Strong front";
  if (v >= 1.03) return "Above average";
  if (v >= 0.97) return "Average";
  if (v >= 0.9) return "Below average";
  return "Weak front";
}

function qbLabel(v: number): string {
  if (v >= 1.15) return "Elite QB play";
  if (v >= 1.05) return "Above average";
  if (v >= 0.95) return "Neutral";
  if (v >= 0.85) return "Below average";
  return "Weak QB";
}

function bbcsLabel(v: number): string {
  if (v >= 1.05) return "Consistent";
  if (v >= 0.98) return "Balanced";
  if (v >= 0.9) return "Volatile";
  return "Boom or bust";
}

function scarcityLabel(v: number): string {
  if (v >= 1.15) return "Very scarce";
  if (v >= 1.05) return "Scarce";
  if (v >= 0.95) return "Neutral";
  if (v >= 0.85) return "Deep position";
  return "Abundant";
}

// Height in inches → 6'1" style string. Handles fractional values (e.g. 73.5).
function formatHeight(inches: number | null): string {
  if (inches === null) return "—";
  const totalIn = Math.round(inches);
  const ft = Math.floor(totalIn / 12);
  const inch = totalIn % 12;
  return `${ft}'${inch}"`;
}

// RAS-style 0-10 color. Matches the /rookies table thresholds.
function rasColorClass(v: number | null): string {
  if (v === null) return "text-zinc-400";
  if (v >= 8) return "text-emerald-600 dark:text-emerald-400 font-semibold";
  if (v >= 5) return "text-zinc-700 dark:text-zinc-200";
  return "text-rose-600 dark:text-rose-400";
}

function hsmLabel(v: string): string {
  const c = v.toUpperCase();
  if (c === "HIGH") return "High confidence";
  if (c === "MEDIUM") return "Medium confidence";
  if (c === "LOW") return "Low confidence";
  return "No comps";
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fmt?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";

  const sb = createServerClient();

  const [playerRes, seasonsRes, snapshotRes, marketRes, hsmRes, combineRes] =
    await Promise.all([
      sb.from("players").select("*").eq("player_id", id).maybeSingle(),
      sb
        .from("player_seasons")
        .select("*")
        .eq("player_id", id)
        .order("season", { ascending: false }),
      sb
        .from("dpv_snapshots")
        .select("*")
        .eq("player_id", id)
        .eq("scoring_format", fmt)
        .maybeSingle(),
      sb
        .from("market_values")
        .select("market_value_normalized, position_rank, overall_rank")
        .eq("player_id", id)
        .eq("scoring_format", fmt)
        .eq("source", "fantasycalc")
        .maybeSingle(),
      sb
        .from("hsm_comps")
        .select("comps, summary")
        .eq("player_id", id)
        .maybeSingle(),
      sb
        .from("combine_stats")
        .select(
          "combine_season, height_in, weight_lb, forty, bench, vertical, broad_jump, cone, shuttle, athleticism_score, metrics_count",
        )
        .eq("player_id", id)
        .maybeSingle(),
    ]);

  if (playerRes.error || !playerRes.data) return notFound();

  const player = playerRes.data;
  const seasons = seasonsRes.data ?? [];
  const snapshot = snapshotRes.data;
  const market = marketRes.data;
  const combine = combineRes.data as
    | {
        combine_season: number | null;
        height_in: number | null;
        weight_lb: number | null;
        forty: number | null;
        bench: number | null;
        vertical: number | null;
        broad_jump: number | null;
        cone: number | null;
        shuttle: number | null;
        athleticism_score: number | null;
        metrics_count: number | null;
      }
    | null;
  const hsm = hsmRes.data as
    | {
        comps: Array<{
          playerId: string;
          name: string;
          anchorSeason: number;
          anchorAge: number;
          anchorPPG: number;
          nextPPG: number | null;
          nextPPG1?: number | null;
          nextPPG2?: number | null;
          nextPPG3?: number | null;
          similarity: number;
        }>;
        summary: {
          n: number;
          meanNextPPG: number | null;
          medianNextPPG: number | null;
          breakoutRate: number | null;
          bustRate: number | null;
          projectedPPG?: number | null;
          proj1?: number | null;
          proj2?: number | null;
          proj3?: number | null;
          n1?: number;
          n2?: number;
          n3?: number;
        };
      }
    | null;
  type RookiePriorBreakdown = {
    kind: "rookie_prior";
    base: number;
    oLineMult: number;
    qbTierMult: number;
    ageMult: number;
    formatMult: number;
    lapseMult?: number;
    missedSeasons?: number;
  };
  const rawBreakdown = snapshot?.breakdown as
    | DPVBreakdown
    | RookiePriorBreakdown
    | undefined;
  const isRookiePrior =
    rawBreakdown !== undefined &&
    "kind" in rawBreakdown &&
    rawBreakdown.kind === "rookie_prior";
  const breakdown: DPVBreakdown | undefined = isRookiePrior
    ? undefined
    : (rawBreakdown as DPVBreakdown | undefined);
  const priorBreakdown: RookiePriorBreakdown | undefined = isRookiePrior
    ? (rawBreakdown as RookiePriorBreakdown)
    : undefined;
  const age = ageFromBirth(player.birthdate);
  const marketValue =
    market?.market_value_normalized !== null && market?.market_value_normalized !== undefined
      ? Math.round(Number(market.market_value_normalized))
      : null;

  // Position-wide DPV + market fetch (used for position rank + market delta)
  const [allDpvRes, allMktRes] = await Promise.all([
    sb
      .from("dpv_snapshots")
      .select("player_id, dpv, players!inner(position)")
      .eq("scoring_format", fmt)
      .eq("players.position", player.position),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized, players!inner(position)")
      .eq("scoring_format", fmt)
      .eq("source", "fantasycalc")
      .eq("players.position", player.position),
  ]);

  // Full position rank by DPV across all ranked players at this position.
  const allDpvSorted = [...(allDpvRes.data ?? [])].sort(
    (a, b) => b.dpv - a.dpv,
  );
  const positionTotal = allDpvSorted.length;
  const positionRank =
    allDpvSorted.findIndex((s) => s.player_id === id) + 1 || null;

  // Rank delta within intersection of players with BOTH DPV and market.
  let dpvPosRank: number | null = null;
  let mktPosRank: number | null = null;
  if (marketValue !== null && snapshot?.dpv !== undefined) {
    const mktMap = new Map<string, number>();
    for (const m of allMktRes.data ?? []) {
      if (m.market_value_normalized !== null) {
        mktMap.set(m.player_id, Number(m.market_value_normalized));
      }
    }
    const intersect = (allDpvRes.data ?? []).filter((s) =>
      mktMap.has(s.player_id),
    );
    const dpvSorted = [...intersect].sort((a, b) => b.dpv - a.dpv);
    const mktSorted = [...intersect].sort(
      (a, b) => (mktMap.get(b.player_id) ?? 0) - (mktMap.get(a.player_id) ?? 0),
    );
    dpvPosRank = dpvSorted.findIndex((s) => s.player_id === id) + 1 || null;
    mktPosRank = mktSorted.findIndex((s) => s.player_id === id) + 1 || null;
  }
  const marketDelta =
    dpvPosRank !== null && mktPosRank !== null
      ? mktPosRank - dpvPosRank
      : null;

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Rankings
        </Link>
      </div>

      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {player.name}
          </h1>
          <div className="text-sm text-zinc-500 mt-1 flex gap-3">
            <span>{player.position}</span>
            <span>·</span>
            <span>{player.current_team ?? "—"}</span>
            <span>·</span>
            <span>Age {age !== null ? age.toFixed(1) : "—"}</span>
          </div>
        </div>
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {FORMATS.map((f) => (
            <Link
              key={f.key}
              href={`/player/${id}?fmt=${f.key}`}
              className={`px-3 py-1.5 ${
                fmt === f.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            DPV
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {snapshot?.dpv ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            {snapshot?.tier ?? "No snapshot"}
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Market (FantasyCalc)
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {marketValue ?? "—"}
          </div>
          <div className="text-sm mt-1">
            {marketDelta === null ? (
              <span className="text-zinc-500">No market data</span>
            ) : (
              <>
                <span className="text-zinc-500">
                  DPV {player.position}
                  {dpvPosRank} · Market {player.position}
                  {mktPosRank}
                </span>
                <span
                  className={`ml-2 font-medium ${
                    marketDelta > 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : marketDelta < 0
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-zinc-500"
                  }`}
                >
                  {marketDelta > 0
                    ? `+${marketDelta} (buy)`
                    : marketDelta < 0
                    ? `${marketDelta} (sell)`
                    : "aligned"}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            {isRookiePrior ? "Rookie Prior" : "BPS (3-yr weighted PPG)"}
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {isRookiePrior
              ? "—"
              : breakdown?.bps.toFixed(1) ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            {isRookiePrior
              ? "Forward-looking estimate (no NFL season yet)"
              : "Recency-weighted fantasy PPG"}
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Position Rank
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {positionRank !== null
              ? `${player.position}${positionRank}`
              : "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            {positionTotal > 0
              ? `of ${positionTotal} ${player.position}s`
              : "Unranked"}
          </div>
        </div>
      </div>

      {priorBreakdown && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Rookie Prior</h2>
          <div className="rounded-md border border-amber-200 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20 p-4 mb-3 text-sm text-amber-900 dark:text-amber-200">
            This player has no qualifying NFL season yet. DPV is a
            forward-looking prior based on draft capital, landing spot, and
            age. Replaced by a production-based DPV as soon as they log 7+
            games in a season.
            {(priorBreakdown.missedSeasons ?? 0) > 0 && (
              <span>
                {" "}
                <b>Lapse decay applied:</b>{" "}
                {priorBreakdown.missedSeasons} post-draft season
                {(priorBreakdown.missedSeasons ?? 0) === 1 ? "" : "s"} without
                a qualifying year.
              </span>
            )}
          </div>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {(
                  [
                    [
                      "Draft Capital (base)",
                      priorBreakdown.base.toLocaleString(),
                    ],
                    [
                      "Offensive Line",
                      `×${priorBreakdown.oLineMult.toFixed(2)}`,
                    ],
                    [
                      "QB Situation",
                      `×${priorBreakdown.qbTierMult.toFixed(2)}`,
                    ],
                    ["Age at Draft", `×${priorBreakdown.ageMult.toFixed(2)}`],
                    [
                      "Format Adjust",
                      `×${priorBreakdown.formatMult.toFixed(2)}`,
                    ],
                    ...(priorBreakdown.lapseMult !== undefined &&
                    priorBreakdown.lapseMult < 1
                      ? ([
                          [
                            "Lapse Decay",
                            `×${priorBreakdown.lapseMult.toFixed(2)}`,
                          ],
                        ] as Array<[string, string]>)
                      : []),
                  ] as Array<[string, string]>
                ).map(([label, value]) => (
                  <tr
                    key={label}
                    className="border-t border-zinc-100 dark:border-zinc-800 first:border-t-0"
                  >
                    <td className="px-4 py-2 text-zinc-500">{label}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {breakdown && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Breakdown</h2>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {(
                  [
                    ["Production", bpsLabel(player.position, breakdown.bps)],
                    ["Age Curve", ageModifierLabel(breakdown.ageModifier)],
                    player.position !== "QB" && [
                      "Opportunity",
                      opportunityLabel(
                        player.position,
                        breakdown.opportunityScore,
                      ),
                    ],
                    // OL only matters for RBs in the model — WR/TE/QB multipliers
                    // barely move (TE is a literal 1.0 no-op). Hiding keeps the
                    // table honest instead of reading "Average" on everyone.
                    player.position === "RB" && [
                      "Offensive Line",
                      olineLabel(breakdown.olineModifier),
                    ],
                    // QB play drives WR/TE outcomes; RB multiplier range is
                    // 0.98-1.02 so the row is pure noise. QB position never
                    // shows (already skipped by the non-QB check below).
                    (player.position === "WR" || player.position === "TE") && [
                      "QB Situation",
                      qbLabel(breakdown.qbQualityModifier),
                    ],
                    ["Consistency", bbcsLabel(breakdown.bbcsModifier)],
                    [
                      "Positional Scarcity",
                      scarcityLabel(breakdown.scarcityMultiplier),
                    ],
                    ["Historical Comps", hsmLabel(breakdown.hsmConfidence)],
                  ].filter(Boolean) as Array<[string, string]>
                ).map(([label, value]) => (
                  <tr
                    key={label}
                    className="border-t border-zinc-100 dark:border-zinc-800 first:border-t-0"
                  >
                    <td className="px-4 py-2 text-zinc-500">{label}</td>
                    <td className="px-4 py-2 text-right font-medium">
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {hsm && hsm.comps.length > 0 && (
        <div className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Historical Comps</h2>
            <div className="text-xs text-zinc-500">
              Scaled Euclidean on PPG · age · usage · context · trajectory
            </div>
          </div>
          {hsm.summary.n > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4">
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Year 1 PPG
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1">
                  {hsm.summary.proj1 ?? hsm.summary.meanNextPPG ?? "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  n={hsm.summary.n1 ?? hsm.summary.n}
                </div>
              </div>
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Year 2 PPG
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1">
                  {hsm.summary.proj2 ?? "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  n={hsm.summary.n2 ?? 0}
                </div>
              </div>
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Year 3 PPG
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1">
                  {hsm.summary.proj3 ?? "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  n={hsm.summary.n3 ?? 0}
                </div>
              </div>
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Breakout Rate
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1 text-emerald-600 dark:text-emerald-400">
                  {hsm.summary.breakoutRate !== null
                    ? `${Math.round(hsm.summary.breakoutRate * 100)}%`
                    : "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  {player.position === "QB" ? "≥20 PPG (Y1)" : "≥15 PPG (Y1)"}
                </div>
              </div>
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Bust Rate
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1 text-rose-600 dark:text-rose-400">
                  {hsm.summary.bustRate !== null
                    ? `${Math.round(hsm.summary.bustRate * 100)}%`
                    : "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  {player.position === "QB" ? "≤14 PPG (Y1)" : "≤8 PPG (Y1)"}
                </div>
              </div>
            </div>
          )}
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm min-w-[560px]">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-3 py-2 text-left">Player</th>
                  <th className="px-3 py-2 text-right">Season</th>
                  <th className="px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2 text-right">PPG</th>
                  <th className="px-3 py-2 text-right">Next PPG</th>
                  <th className="px-3 py-2 text-right">Similarity</th>
                </tr>
              </thead>
              <tbody>
                {hsm.comps.map((c, i) => (
                  <tr
                    key={`${c.playerId}-${c.anchorSeason}-${i}`}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-3 py-2">
                      <Link
                        href={`/player/${c.playerId}?fmt=${fmt}`}
                        className="font-medium hover:underline"
                      >
                        {c.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {c.anchorSeason}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {c.anchorAge}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.anchorPPG}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {c.nextPPG ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {c.similarity.toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {combine && (
        <div className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Combine</h2>
            <div className="text-xs text-zinc-500">
              {combine.combine_season ? `${combine.combine_season} · ` : ""}
              {combine.metrics_count ?? 0} metric
              {(combine.metrics_count ?? 0) === 1 ? "" : "s"}
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3 mb-3">
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Athleticism
              </div>
              <div
                className={`text-2xl tabular-nums mt-1 ${rasColorClass(
                  combine.athleticism_score !== null
                    ? Number(combine.athleticism_score)
                    : null,
                )}`}
              >
                {combine.athleticism_score !== null
                  ? Number(combine.athleticism_score).toFixed(1)
                  : "—"}
              </div>
              <div className="text-xs text-zinc-500 mt-1">RAS-style 0–10</div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Height / Weight
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {formatHeight(
                  combine.height_in !== null ? Number(combine.height_in) : null,
                )}
                {combine.weight_lb !== null && (
                  <span className="text-zinc-400 text-base font-normal">
                    {" · "}
                    {Math.round(Number(combine.weight_lb))} lb
                  </span>
                )}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                40-yd Dash
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {combine.forty !== null ? Number(combine.forty).toFixed(2) : "—"}
              </div>
              <div className="text-xs text-zinc-500 mt-1">seconds</div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Vertical
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {combine.vertical !== null
                  ? `${Number(combine.vertical).toFixed(1)}"`
                  : "—"}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Broad Jump
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {combine.broad_jump !== null
                  ? `${Math.round(Number(combine.broad_jump))}"`
                  : "—"}
              </div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                3-Cone
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {combine.cone !== null
                  ? Number(combine.cone).toFixed(2)
                  : "—"}
              </div>
              <div className="text-xs text-zinc-500 mt-1">seconds</div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                20-yd Shuttle
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {combine.shuttle !== null
                  ? Number(combine.shuttle).toFixed(2)
                  : "—"}
              </div>
              <div className="text-xs text-zinc-500 mt-1">seconds</div>
            </div>
            <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
              <div className="text-xs uppercase tracking-wider text-zinc-500">
                Bench
              </div>
              <div className="text-2xl font-semibold tabular-nums mt-1">
                {combine.bench !== null ? `${combine.bench}` : "—"}
              </div>
              <div className="text-xs text-zinc-500 mt-1">225 lb reps</div>
            </div>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-3">Seasons</h2>
        {seasons.length === 0 ? (
          <div className="text-sm text-zinc-500">No season data.</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm min-w-[820px]">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-3 py-2 text-left">Season</th>
                  <th className="px-3 py-2 text-left">Team</th>
                  <th className="px-3 py-2 text-right">G</th>
                  <th className="px-3 py-2 text-right">Pass Yd</th>
                  <th className="px-3 py-2 text-right">Pass TD</th>
                  <th className="px-3 py-2 text-right">Rush Yd</th>
                  <th className="px-3 py-2 text-right">Rush TD</th>
                  <th className="px-3 py-2 text-right">Rec</th>
                  <th className="px-3 py-2 text-right">Rec Yd</th>
                  <th className="px-3 py-2 text-right">Rec TD</th>
                  <th className="px-3 py-2 text-right">Snap%</th>
                  <th className="px-3 py-2 text-right">Tgt%</th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s) => (
                  <tr
                    key={s.season}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-3 py-2 font-medium">{s.season}</td>
                    <td className="px-3 py-2 text-zinc-500">{s.team ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.games_played}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.passing_yards || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.passing_tds || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.rushing_yards || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.rushing_tds || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.receptions || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.receiving_yards || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.receiving_tds || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.snap_share_pct ? s.snap_share_pct.toFixed(0) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.target_share_pct ? s.target_share_pct.toFixed(1) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
