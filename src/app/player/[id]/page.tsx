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

  const [playerRes, seasonsRes, snapshotRes, marketRes, hsmRes] = await Promise.all([
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
  ]);

  if (playerRes.error || !playerRes.data) return notFound();

  const player = playerRes.data;
  const seasons = seasonsRes.data ?? [];
  const snapshot = snapshotRes.data;
  const market = marketRes.data;
  const hsm = hsmRes.data as
    | {
        comps: Array<{
          playerId: string;
          name: string;
          anchorSeason: number;
          anchorAge: number;
          anchorPPG: number;
          nextPPG: number | null;
          similarity: number;
        }>;
        summary: {
          n: number;
          meanNextPPG: number | null;
          medianNextPPG: number | null;
          breakoutRate: number | null;
          bustRate: number | null;
        };
      }
    | null;
  const breakdown = snapshot?.breakdown as DPVBreakdown | undefined;
  const age = ageFromBirth(player.birthdate);
  const marketValue =
    market?.market_value_normalized !== null && market?.market_value_normalized !== undefined
      ? Math.round(Number(market.market_value_normalized))
      : null;

  // Compute position-scoped rank delta (intersection of players with both
  // DPV + market in this format).
  let dpvPosRank: number | null = null;
  let mktPosRank: number | null = null;
  if (marketValue !== null && snapshot?.dpv !== undefined) {
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
            BPS (3-yr weighted PPG)
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {breakdown?.bps.toFixed(1) ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            Recency-weighted fantasy PPG
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Age Modifier
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            ×{breakdown?.ageModifier.toFixed(2) ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            Position-specific aging curve
          </div>
        </div>
      </div>

      {breakdown && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Breakdown</h2>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {[
                  ["Base Production Score", breakdown.bps.toFixed(2)],
                  ["Age Modifier", `×${breakdown.ageModifier.toFixed(3)}`],
                  ["Opportunity Score", breakdown.opportunityScore.toFixed(3)],
                  ["O-Line Modifier", `×${breakdown.olineModifier.toFixed(3)}`],
                  ["QB Quality Modifier", `×${breakdown.qbQualityModifier.toFixed(3)}`],
                  ["Boom/Bust Modifier", `×${breakdown.bbcsModifier.toFixed(3)}`],
                  ["Scoring Format Weight", `×${breakdown.scoringFormatWeight.toFixed(3)}`],
                  ["Positional Scarcity", `×${breakdown.scarcityMultiplier.toFixed(3)}`],
                  ["Raw DPV", breakdown.dpvRaw.toFixed(2)],
                  ["HSM Confidence", breakdown.hsmConfidence],
                ].map(([label, value]) => (
                  <tr
                    key={label}
                    className="border-t border-zinc-100 dark:border-zinc-800 first:border-t-0"
                  >
                    <td className="px-4 py-2 text-zinc-500">{label}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">
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
              Cosine similarity on PPG · age · opportunity · context
            </div>
          </div>
          {hsm.summary.n > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Mean Next PPG
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1">
                  {hsm.summary.meanNextPPG ?? "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  Median {hsm.summary.medianNextPPG ?? "—"} · n={hsm.summary.n}
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
                  {player.position === "QB" ? "≥20 PPG" : "≥15 PPG"}
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
                  {player.position === "QB" ? "≤14 PPG" : "≤8 PPG"}
                </div>
              </div>
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
                <div className="text-xs uppercase tracking-wider text-zinc-500">
                  Top Similarity
                </div>
                <div className="text-2xl font-bold tabular-nums mt-1">
                  {hsm.comps[0]
                    ? hsm.comps[0].similarity.toFixed(3)
                    : "—"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  Closest historical match
                </div>
              </div>
            </div>
          )}
          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm">
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

      <div>
        <h2 className="text-lg font-semibold mb-3">Seasons</h2>
        {seasons.length === 0 ? (
          <div className="text-sm text-zinc-500">No season data.</div>
        ) : (
          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm">
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
