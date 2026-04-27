import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/dpv/constants";
import type { ScoringFormat } from "@/lib/dpv/types";
import { fetchSleeperTeams, sleeperTeamKey } from "@/lib/sleeper/teams";
import {
  athleticismScoreFromMetrics,
  fetchCombineDataset,
  normalizeCombineName,
} from "@/lib/combine/csv";
import {
  computeRookieTradeValue,
  roundFromOverallPick,
} from "@/lib/rookies/values";

// /rookies — current draft class view. Shows prospect consensus rankings
// pre-draft and overlays draft capital / team / combine / rookie prior DPV
// as each data source lands:
//
//   Pre-draft: prospect_consensus only → consensus grade visible, other
//     columns empty.
//   Post-draft (for a given pick): sync-draft-capital populates players row,
//     compute-dpv writes a rookie prior snapshot, ingest-combine attaches
//     RAS → all columns fill in automatically.
//
// Prospects and players are joined by normalized name (prospects predate
// gsis_id assignment). Unmatched rows on either side are still rendered.

const INCOMING_CLASS_YEAR = CURRENT_SEASON + 1;

type SearchParams = Promise<{ fmt?: string; pos?: string }>;

const FORMATS: { key: ScoringFormat; label: string }[] = [
  { key: "STANDARD", label: "Standard" },
  { key: "HALF_PPR", label: "Half PPR" },
  { key: "FULL_PPR", label: "Full PPR" },
];

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE"] as const;

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

// Strip suffixes (Jr./III), punctuation, lowercase. Defensive against
// "Marvin Harrison Jr." vs "Marvin Harrison" etc.
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function RookiesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";
  const pos = (sp.pos || "ALL").toUpperCase();

  const sb = createServerClient();
  // Pull all the data we need in parallel:
  //   - Prospect consensus rankings (pre-draft).
  //   - Player records for the incoming class (post-draft sync-draft-capital).
  //   - Combine metrics for athleticism context.
  //   - DPV snapshots for the rookie prior valuations.
  //   - FantasyCalc market values, used for the per-position Buy/Sell badge.
  //   - Live Sleeper roster — fallback for `current_team` when nflverse hasn't
  //     yet published the player record (typically 1-3 days post-draft).
  const [
    prospectsRes,
    playersRes,
    combineRes,
    snapsRes,
    marketRes,
    sleeperTeams,
    combineCsv,
    teamSeasonRows,
  ] = await Promise.all([
    sb
      .from("prospect_consensus")
      .select(
        "prospect_id, name, position, avg_rank, normalized_grade, source_count, projected_round, projected_overall_pick",
      )
      .eq("draft_year", INCOMING_CLASS_YEAR)
      .order("avg_rank", { ascending: true }),
    sb
      .from("players")
      .select("player_id, name, position, current_team, draft_round, draft_year")
      .eq("draft_year", INCOMING_CLASS_YEAR),
    sb
      .from("combine_stats")
      .select("player_id, athleticism_score, forty, vertical, broad_jump"),
    sb
      .from("dpv_snapshots")
      .select(
        "player_id, dpv, tier, players(position)",
      )
      .eq("scoring_format", fmt),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", fmt)
      .eq("source", "fantasycalc"),
    fetchSleeperTeams(),
    // nflverse combine.csv — covers prospects who don't have a gsis_id yet
    // (and therefore aren't in our combine_stats table). Used for the 40
    // and pre-draft RAS-equivalent on this page.
    fetchCombineDataset(),
    // Per-team OL/QB context for the synthetic rookie prior. One pull,
    // indexed by team for O(1) lookup per prospect.
    sb
      .from("team_seasons")
      .select("team, season, oline_composite_rank, qb_tier")
      .order("season", { ascending: false }),
  ]);

  if (prospectsRes.error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900 dark:bg-red-950/40 dark:text-red-200">
        <p className="font-medium">Could not load rookies</p>
        <pre className="text-xs mt-2 opacity-80">
          {prospectsRes.error.message}
        </pre>
      </div>
    );
  }

  const prospects = prospectsRes.data ?? [];
  const players = playersRes.data ?? [];
  const combine = combineRes.data ?? [];
  const snaps = snapsRes.data ?? [];
  const market = marketRes.data ?? [];

  const playerByNorm = new Map<string, (typeof players)[number]>();
  for (const p of players) playerByNorm.set(normalize(p.name), p);

  const combineByPlayer = new Map<string, (typeof combine)[number]>();
  for (const c of combine) combineByPlayer.set(c.player_id, c);

  const snapByPlayer = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) snapByPlayer.set(s.player_id, s);

  const marketByPlayer = new Map<string, number>();
  for (const m of market) {
    const v = m.market_value_normalized;
    if (v !== null && v !== undefined) marketByPlayer.set(m.player_id, Number(v));
  }

  // Latest team_seasons row per team — drives the OL/QB-tier landing-spot
  // multipliers inside the synthetic rookie prior.
  const latestTeamCtx = new Map<
    string,
    { olineRank: number | null; qbTier: number | null }
  >();
  for (const row of (teamSeasonRows.data ?? []) as Array<{
    team: string;
    oline_composite_rank: number | null;
    qb_tier: number | null;
  }>) {
    if (!latestTeamCtx.has(row.team)) {
      latestTeamCtx.set(row.team, {
        olineRank: row.oline_composite_rank,
        qbTier: row.qb_tier,
      });
    }
  }

  // Per-position rank delta within (DPV ∩ Market). Identical signal to the
  // trade calculator: positive delta = DPV ranks them higher than market
  // does = potential Buy. We need the FULL universe (NFL + rookies) so the
  // delta means the same thing here as it does on the trade page — a rookie
  // with high DPV and no market price yet appears as no-signal, not "Buy".
  type DpvWithPos = {
    player_id: string;
    dpv: number;
    position: string | null;
  };
  const allDpv: DpvWithPos[] = (snaps as Array<{
    player_id: string;
    dpv: number;
    players: { position: string } | { position: string }[] | null;
  }>).map((r) => {
    // Supabase nested-select returns either a single object or an array
    // depending on relationship cardinality. Normalize to a string|null.
    const pj = r.players;
    const position = Array.isArray(pj)
      ? pj[0]?.position ?? null
      : pj?.position ?? null;
    return { player_id: r.player_id, dpv: r.dpv, position };
  });
  const deltaByPlayer = new Map<string, number>();
  const positionsAll = Array.from(
    new Set(allDpv.map((p) => p.position).filter((x): x is string => !!x)),
  );
  for (const pos of positionsAll) {
    const inPos = allDpv.filter(
      (p) => p.position === pos && marketByPlayer.has(p.player_id),
    );
    const dpvSorted = [...inPos].sort((a, b) => b.dpv - a.dpv);
    const mktSorted = [...inPos].sort(
      (a, b) =>
        (marketByPlayer.get(b.player_id) ?? 0) -
        (marketByPlayer.get(a.player_id) ?? 0),
    );
    const dpvRank = new Map(
      dpvSorted.map((p, i) => [p.player_id, i + 1]),
    );
    const mktRank = new Map(
      mktSorted.map((p, i) => [p.player_id, i + 1]),
    );
    for (const p of inPos) {
      const dr = dpvRank.get(p.player_id);
      const mr = mktRank.get(p.player_id);
      if (dr === undefined || mr === undefined) continue;
      // Positive delta = DPV ranks higher (smaller number) than market = Buy.
      deltaByPlayer.set(p.player_id, mr - dr);
    }
  }

  // Buy/Sell threshold matches the trade calculator (5 ranks within position).
  function buySell(
    delta: number | null,
  ): { label: "BUY" | "SELL"; tone: "buy" | "sell" } | null {
    if (delta === null) return null;
    if (delta >= 5) return { label: "BUY", tone: "buy" };
    if (delta <= -5) return { label: "SELL", tone: "sell" };
    return null;
  }

  type RookieRow = {
    key: string;
    name: string;
    position: string | null;
    consensusRank: number | null;
    consensusGrade: number | null;
    sourceCount: number | null;
    projectedRound: number | null;
    playerId: string | null;
    prospectId: string | null;
    team: string | null;
    /** "sleeper" if team came from the Sleeper fallback, "db" if from the
     *  players row. Used purely so the UI can hint at provenance. */
    teamSource: "db" | "sleeper" | null;
    draftRound: number | null;
    ras: number | null;
    forty: number | null;
    dpv: number | null;
    market: number | null;
    marketDelta: number | null;
    tier: string | null;
  };

  // Resolve a team for a row, preferring the players.current_team value and
  // falling back to live Sleeper data when the player record doesn't exist
  // yet (typical 1-3 day window post-draft before nflverse publishes).
  function resolveTeam(
    dbTeam: string | null,
    name: string,
    pos: string | null,
  ): { team: string | null; source: "db" | "sleeper" | null } {
    if (dbTeam) return { team: dbTeam, source: "db" };
    if (pos) {
      const sleeperTeam = sleeperTeams.get(sleeperTeamKey(name, pos));
      if (sleeperTeam) return { team: sleeperTeam, source: "sleeper" };
    }
    return { team: null, source: null };
  }

  const seenPlayerIds = new Set<string>();
  const rows: RookieRow[] = [];

  // 1. Prospect-first rows (pre-draft consensus has the most coverage).
  for (const pr of prospects) {
    const player = playerByNorm.get(normalize(pr.name));
    if (player) seenPlayerIds.add(player.player_id);
    const c = player ? combineByPlayer.get(player.player_id) : undefined;
    const s = player ? snapByPlayer.get(player.player_id) : undefined;
    const position = pr.position ?? player?.position ?? null;
    const { team, source: teamSource } = resolveTeam(
      player?.current_team ?? null,
      pr.name,
      position,
    );
    const market = player ? marketByPlayer.get(player.player_id) ?? null : null;
    const marketDelta = player
      ? deltaByPlayer.get(player.player_id) ?? null
      : null;

    // Pre-draft fallbacks. When there's no players row yet:
    //   - 40-yard dash comes from nflverse combine.csv (name-keyed).
    //   - RAS-equivalent is computed inline from the same z-score / 0-10
    //     formula used post-draft by scripts/ingest-combine.ts.
    //   - DPV / Tier come from the synthetic rookie prior (same
    //     computeRookieTradeValue used to make these prospects tradeable).
    let forty: number | null =
      c?.forty !== null && c?.forty !== undefined ? Number(c.forty) : null;
    let ras: number | null =
      c?.athleticism_score !== null && c?.athleticism_score !== undefined
        ? Number(c.athleticism_score)
        : null;
    let dpv: number | null = s?.dpv ?? null;
    let tier: string | null = s?.tier ?? null;

    if (!player) {
      const csvKey = normalizeCombineName(pr.name);
      const csvRow = combineCsv.byName.get(csvKey);
      if (csvRow) {
        if (forty === null) forty = csvRow.forty;
        if (ras === null) {
          ras = athleticismScoreFromMetrics(
            csvRow,
            combineCsv.statsByPos.get(csvRow.position),
          );
        }
      }
      // Synthetic DPV — same engine as the trade calculator. Falls back
      // automatically once compute-dpv produces a real prior post-publish.
      if (dpv === null) {
        const projectedRound =
          pr.projected_round ??
          roundFromOverallPick(pr.projected_overall_pick);
        const teamCtx = team ? latestTeamCtx.get(team) ?? null : null;
        const synth = position
          ? computeRookieTradeValue({
              prospect: {
                prospectId: pr.prospect_id,
                name: pr.name,
                position,
                projectedRound,
                consensusGrade:
                  pr.normalized_grade !== null
                    ? Number(pr.normalized_grade)
                    : null,
                ageAtDraft: null,
                draftYear: INCOMING_CLASS_YEAR,
              },
              team,
              teamContext: teamCtx,
              scoringFormat: fmt,
            })
          : null;
        if (synth) {
          dpv = synth.dpv;
          tier = synth.tier;
        }
      }
    }

    rows.push({
      key: pr.prospect_id,
      name: pr.name,
      position,
      consensusRank: pr.avg_rank !== null ? Number(pr.avg_rank) : null,
      consensusGrade:
        pr.normalized_grade !== null ? Number(pr.normalized_grade) : null,
      sourceCount: pr.source_count ?? null,
      projectedRound: pr.projected_round ?? null,
      playerId: player?.player_id ?? null,
      prospectId: pr.prospect_id,
      team,
      teamSource,
      draftRound: player?.draft_round ?? null,
      ras,
      forty,
      dpv,
      market,
      marketDelta,
      tier,
    });
  }

  // 2. Drafted rookies who aren't in prospects (late-round surprises).
  // Require draft_round !== null so nflverse "entry_year" camp bodies (futures
  // contracts, practice-squad signings) don't masquerade as incoming-class
  // rookies. A legit post-draft UDFA signing who was tracked as a prospect
  // still surfaces via the prospect-first loop above.
  for (const player of players) {
    if (seenPlayerIds.has(player.player_id)) continue;
    if (player.draft_round === null) continue;
    const c = combineByPlayer.get(player.player_id);
    const s = snapByPlayer.get(player.player_id);
    const { team, source: teamSource } = resolveTeam(
      player.current_team,
      player.name,
      player.position,
    );
    rows.push({
      key: `player:${player.player_id}`,
      name: player.name,
      position: player.position,
      consensusRank: null,
      consensusGrade: null,
      sourceCount: null,
      projectedRound: null,
      playerId: player.player_id,
      prospectId: null,
      team,
      teamSource,
      draftRound: player.draft_round,
      ras:
        c?.athleticism_score !== null && c?.athleticism_score !== undefined
          ? Number(c.athleticism_score)
          : null,
      forty: c?.forty !== null && c?.forty !== undefined ? Number(c.forty) : null,
      dpv: s?.dpv ?? null,
      market: marketByPlayer.get(player.player_id) ?? null,
      marketDelta: deltaByPlayer.get(player.player_id) ?? null,
      tier: s?.tier ?? null,
    });
  }

  // Filter + sort. Drafted rookies float above undrafted via the sort key.
  const filtered = rows.filter((r) =>
    pos === "ALL" ? true : r.position === pos,
  );

  filtered.sort((a, b) => {
    // 1. Drafted with DPV first, sorted by DPV desc.
    if (a.dpv !== null && b.dpv !== null) return b.dpv - a.dpv;
    if (a.dpv !== null) return -1;
    if (b.dpv !== null) return 1;
    // 2. Drafted without DPV yet — use draft round (earlier = higher).
    if (a.draftRound !== null && b.draftRound !== null)
      return a.draftRound - b.draftRound;
    if (a.draftRound !== null) return -1;
    if (b.draftRound !== null) return 1;
    // 3. Undrafted — consensus rank ascending (lower = better).
    if (a.consensusRank !== null && b.consensusRank !== null)
      return a.consensusRank - b.consensusRank;
    if (a.consensusRank !== null) return -1;
    if (b.consensusRank !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  const buildHref = (updates: Partial<{ fmt: string; pos: string }>) => {
    const params = new URLSearchParams();
    const next = { fmt, pos, ...updates };
    if (next.fmt !== "HALF_PPR") params.set("fmt", next.fmt);
    if (next.pos && next.pos !== "ALL") params.set("pos", next.pos);
    const s = params.toString();
    return s ? `/rookies?${s}` : "/rookies";
  };

  const draftedCount = rows.filter((r) => r.draftRound !== null).length;
  const totalCount = rows.length;
  // "Team known" includes Sleeper-fallback hits, since the user just wants
  // to see where rookies landed regardless of where the abbrev came from.
  const teamKnownCount = rows.filter((r) => r.team !== null).length;
  const sleeperFallbackCount = rows.filter(
    (r) => r.teamSource === "sleeper",
  ).length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {INCOMING_CLASS_YEAR} Rookie Class
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Pre-draft consensus grades + post-draft rookie prior DPV (draft
          capital, landing spot, combine, and intra-class depth). Updates as
          picks come in.
        </p>
        <p className="text-xs text-zinc-400 mt-1 tabular-nums">
          {draftedCount}/{totalCount} drafted · {teamKnownCount} with team
          {sleeperFallbackCount > 0 ? ` (${sleeperFallbackCount} via Sleeper)` : ""} ·{" "}
          {rows.filter((r) => r.dpv !== null).length} with DPV prior
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {FORMATS.map((f) => (
            <Link
              key={f.key}
              href={buildHref({ fmt: f.key })}
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
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {POSITIONS.map((p) => (
            <Link
              key={p}
              href={buildHref({ pos: p })}
              className={`px-3 py-1.5 ${
                pos === p
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-sm text-zinc-500">
          No rookies in this class yet. Prospect sync pulls consensus rankings;
          post-draft <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs">sync-draft-capital.ts</code>{" "}
          attaches pick data.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm min-w-[860px]">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-3 py-2 text-left w-10">#</th>
                <th className="px-3 py-2 text-left">Player</th>
                <th className="px-3 py-2 text-left w-14">Pos</th>
                <th className="px-3 py-2 text-left w-20">Team</th>
                <th className="px-3 py-2 text-center w-14">Rd</th>
                <th className="px-3 py-2 text-right w-16">Grade</th>
                <th className="px-3 py-2 text-right w-14">RAS</th>
                <th className="px-3 py-2 text-right w-14">40</th>
                <th className="px-3 py-2 text-right w-20">DPV</th>
                <th className="px-3 py-2 text-right w-20">Mkt</th>
                <th className="px-3 py-2 text-left w-36">Tier</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const badge = buySell(r.marketDelta);
                return (
                <tr
                  key={r.key}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <td className="px-3 py-2 text-zinc-400 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    <span className="inline-flex items-center gap-1.5">
                      {r.playerId ? (
                        <Link
                          href={`/player/${r.playerId}?fmt=${fmt}`}
                          className="hover:underline"
                        >
                          {r.name}
                        </Link>
                      ) : r.prospectId ? (
                        <Link
                          href={`/prospect/${r.prospectId}`}
                          className="hover:underline"
                        >
                          {r.name}
                        </Link>
                      ) : (
                        r.name
                      )}
                      {badge && (
                        <span
                          title={
                            badge.tone === "buy"
                              ? `DPV ranks ${r.marketDelta} spots higher than market within ${r.position}`
                              : `Market ranks ${Math.abs(r.marketDelta ?? 0)} spots higher than DPV within ${r.position}`
                          }
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide ${
                            badge.tone === "buy"
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                              : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                          }`}
                        >
                          {badge.label}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {r.position ? (
                      <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                        {r.position}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-500">
                    {r.team ? (
                      <span
                        title={
                          r.teamSource === "sleeper"
                            ? "Live from Sleeper — official roster pending nflverse update"
                            : undefined
                        }
                        className={
                          r.teamSource === "sleeper"
                            ? "italic text-zinc-500 underline decoration-dotted underline-offset-2 decoration-zinc-300 dark:decoration-zinc-700"
                            : ""
                        }
                      >
                        {r.team}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-center text-zinc-500 tabular-nums">
                    {r.draftRound ? (
                      `R${r.draftRound}`
                    ) : r.projectedRound ? (
                      <span
                        title="Projected round (pre-draft)"
                        className="opacity-70"
                      >
                        R{r.projectedRound}
                        <span className="text-[10px] ml-0.5 text-zinc-400">
                          p
                        </span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.consensusGrade !== null
                      ? r.consensusGrade.toFixed(0)
                      : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      r.ras === null
                        ? "text-zinc-400"
                        : r.ras >= 8
                        ? "text-emerald-600 dark:text-emerald-400 font-medium"
                        : r.ras >= 5
                        ? "text-zinc-600 dark:text-zinc-300"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {r.ras !== null ? r.ras.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.forty !== null ? r.forty.toFixed(2) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {r.dpv !== null ? r.dpv : <span className="text-zinc-400 font-normal">—</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.market !== null
                      ? Math.round(r.market)
                      : <span className="text-zinc-400">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {r.tier ?? (
                      <span className="text-zinc-400">Pre-draft</span>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
