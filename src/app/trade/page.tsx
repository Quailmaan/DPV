import Link from "next/link";
import { getCurrentTier } from "@/lib/billing/tier";
import { buildMarketDeltaMap } from "@/lib/dpv/marketDelta";
import { createServerClient } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/dpv/constants";
import type { ScoringFormat } from "@/lib/dpv/types";
import {
  generatePickPlayers,
  generateTeamRoundPicks,
  type LeaguePickRow,
} from "@/lib/picks/values";
import {
  generateRookieTradeEntries,
  roundFromOverallPick,
  type RookieValueInput,
} from "@/lib/rookies/values";
import { fetchSleeperTeams, sleeperTeamKey } from "@/lib/sleeper/teams";
import {
  isSuperflexConstruction,
  leagueReplacementDPV,
} from "@/lib/dpv/scarcity";
import TradeCalculator, {
  type TradePlayer,
  type LeagueRosterOption,
} from "./TradeCalculator";
import MultiTradeAnalyzer from "./MultiTradeAnalyzer";
import {
  listMyLeaguesForAnalyzer,
  loadAnalyzerLeague,
  type AnalyzerLeagueData,
  type LeagueOption,
} from "./multiTradeActions";

// Same name normalization as /rookies — used to detect when a synthetic
// rookie entry duplicates a real DPV snapshot (post-publish). Once
// nflverse + compute-dpv land a real prior, the synthetic version drops out.
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type SearchParams = Promise<{
  fmt?: string;
  league?: string;
  from?: string;
  // Deep-link prefill — used by the trade-finder cards on the league
  // page. `to` is the partner roster id; `give` / `receive` are
  // comma-separated player ids that the trade calc should pre-stage.
  to?: string;
  give?: string;
  receive?: string;
  // Tool switcher: "calc" (default; existing 1-on-1 calculator) or
  // "multi" (Pro-gated multi-team trade analyzer that uses the user's
  // synced league rosters).
  tool?: string;
}>;

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

export default async function TradePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const fromRosterId = sp.from ?? null;
  const toRosterId = sp.to ?? null;
  // Comma-separated id lists. Empty strings collapse to []; the trade
  // calculator just ignores ids that don't match a player.
  const giveIds = (sp.give ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const receiveIds = (sp.receive ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // Pro gates: league-aware mode (per-team rosters, traded picks) and the
  // Buy/Sell market-delta flags both require Pro. Free users get the same
  // calculator without those Pro-only signals — they can still pick any
  // player + raw DPV math.
  const tierState = await getCurrentTier();
  const isPro = tierState.tier === "pro";
  const requestedLeague = isPro ? sp.league ?? null : null;
  const tool = sp.tool === "multi" ? "multi" : "calc";

  // Multi-team analyzer plumbing — load the synced league list (cheap)
  // and, if a league is selected with tool=multi, the full analyzer
  // payload (rosters + picks + scaled market). Both calls short-circuit
  // for free users inside the action so there's no leaked work.
  let myLeagues: LeagueOption[] = [];
  let analyzerData: AnalyzerLeagueData | null = null;
  if (tool === "multi") {
    myLeagues = await listMyLeaguesForAnalyzer();
    if (isPro && requestedLeague) {
      const res = await loadAnalyzerLeague(requestedLeague);
      if (!("error" in res)) analyzerData = res;
    }

    // Short-circuit: the multi-team analyzer doesn't need the calculator's
    // heavy DPV/market/rookies/picks load. Render the page shell with
    // just the tab switcher and the analyzer body.
    return (
      <div>
        <div className="mb-4">
          <h1 className="text-2xl font-semibold tracking-tight">
            Multi-Team Trade Analyzer
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Build a 2-, 3-, or up-to-6-team trade from your synced league.
            Each side gets a PYV/market blend verdict with sell-window
            flags.
          </p>
        </div>
        <ToolTabs tool="multi" requestedLeague={requestedLeague} fmt={sp.fmt} />
        <MultiTradeAnalyzer
          isPro={isPro}
          myLeagues={myLeagues}
          leagueData={analyzerData}
        />
      </div>
    );
  }

  const sb = await createServerClient();

  let fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";
  let leagueName: string | null = null;
  let rosterOptions: LeagueRosterOption[] = [];
  // Construction shapes the trade verdict — SF leagues weight QBs harder,
  // 2RB+FLEX leagues weight RBs harder. Captured from Sleeper at sync time.
  let leagueRosterPositions: string[] | null = null;
  let leagueTotalRosters: number | null = null;
  // Per-roster pick ownership, sourced from Sleeper's traded_picks endpoint
  // at sync time. Only loaded when a league is selected; outside league
  // context we render the full slot-level pick set instead.
  let leaguePicks: LeaguePickRow[] = [];

  if (requestedLeague) {
    const [leagueRes, rostersRes, picksRes] = await Promise.all([
      sb.from("leagues").select("*").eq("league_id", requestedLeague).maybeSingle(),
      sb
        .from("league_rosters")
        .select(
          "roster_id, owner_display_name, team_name, player_ids",
        )
        .eq("league_id", requestedLeague)
        .order("roster_id", { ascending: true }),
      sb
        .from("league_picks")
        .select("season, round, original_roster_id, owner_roster_id")
        .eq("league_id", requestedLeague),
    ]);
    if (leagueRes.data) {
      leagueName = leagueRes.data.name;
      // League format overrides search param so trade uses the right scoring.
      if (isScoringFormat(leagueRes.data.scoring_format)) {
        fmt = leagueRes.data.scoring_format;
      }
      // roster_positions is null for leagues synced before the column was
      // added — they fall back to the standard 12-team build downstream.
      if (Array.isArray(leagueRes.data.roster_positions)) {
        leagueRosterPositions = leagueRes.data.roster_positions as string[];
      }
      if (typeof leagueRes.data.total_rosters === "number") {
        leagueTotalRosters = leagueRes.data.total_rosters;
      }
    }
    rosterOptions = ((rostersRes.data ?? []) as Array<{
      roster_id: number;
      owner_display_name: string | null;
      team_name: string | null;
      player_ids: string[];
    }>).map((r) => ({
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
      playerIds: r.player_ids,
    }));
    leaguePicks = ((picksRes.data ?? []) as Array<{
      season: number;
      round: number;
      original_roster_id: number;
      owner_roster_id: number;
    }>).map((p) => ({
      season: p.season,
      round: p.round,
      original_roster_id: p.original_roster_id,
      owner_roster_id: p.owner_roster_id,
    }));
  }

  const [{ data }, { data: marketData }] = await Promise.all([
    sb
      .from("dpv_snapshots")
      .select(
        "dpv, tier, player_id, players(name, position, current_team, birthdate)",
      )
      .eq("scoring_format", fmt)
      .order("dpv", { ascending: false }),
    // FantasyCalc market values for the same format. Used for the second
    // axis of the trade verdict (production vs. price) and for per-player
    // Buy/Sell badges.
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", fmt)
      .eq("source", "fantasycalc"),
  ]);

  // Build a player_id → market value map. Market and DPV use different
  // absolute scales (FantasyCalc vs our 0-10k DPV), so we don't compare
  // raw values across systems — we compare *position ranks* within the
  // intersection of players who have both. Below we compute, per position,
  // each player's DPV rank and Market rank within that intersection.
  const marketMap = new Map<string, number>();
  for (const m of marketData ?? []) {
    const v = m.market_value_normalized;
    if (v !== null && v !== undefined) {
      marketMap.set(m.player_id, Number(v));
    }
  }

  const now = Date.now();

  // First pass: build raw rows so we can compute per-position ranks.
  type Pre = {
    id: string;
    name: string;
    position: string;
    team: string | null;
    birthdate: string | null;
    dpv: number;
    market: number | null;
    tier: string;
  };
  const pre: Pre[] = (data ?? [])
    .filter((r) => r.players)
    .map((r) => {
      const p = r.players as unknown as {
        name: string;
        position: string;
        current_team: string | null;
        birthdate: string | null;
      };
      return {
        id: r.player_id,
        name: p.name,
        position: p.position,
        team: p.current_team ?? null,
        birthdate: p.birthdate,
        dpv: r.dpv,
        market: marketMap.get(r.player_id) ?? null,
        tier: r.tier,
      };
    });

  // Per-position rank deltas. Shared helper — same math powers the
  // sell-window indicator on player pages and the league roster view.
  const deltaById = buildMarketDeltaMap(pre);

  const nflPlayers: TradePlayer[] = pre.map((p) => {
    const age = p.birthdate
      ? (now - new Date(p.birthdate).getTime()) /
        (365.25 * 24 * 3600 * 1000)
      : null;
    const hasMarket = p.market !== null;
    return {
      id: p.id,
      name: p.name,
      position: p.position,
      team: p.team,
      age: age !== null ? Number(age.toFixed(1)) : null,
      dpv: p.dpv,
      // Fall back to DPV when no market price exists so sums stay sane.
      // The hasMarket flag tells the verdict math whether this player
      // contributes a real disagreement signal vs. a no-op fallback.
      market: p.market ?? p.dpv,
      hasMarket,
      // Buy/Sell flags are a Pro feature — strip the delta for free users
      // so the calculator falls through the null-delta branch in
      // buySellBadge() and renders no badge.
      marketDelta: isPro ? deltaById.get(p.id) ?? null : null,
      tier: p.tier,
    };
  });

  // Pull per-year class depth signal (Phase 3). pickDpv uses these counts
  // to shape the pick curve slot-by-slot; years with no row default to
  // neutral so picks still render before prospect data exists.
  const { data: classRows } = await sb
    .from("class_strength")
    .select("draft_year, r1_offensive_count, top15_offensive_count");
  const classOverrides: Record<
    number,
    { r1_offensive_count: number | null; top15_offensive_count: number | null }
  > = {};
  for (const row of classRows ?? []) {
    const r = row as {
      draft_year: number;
      r1_offensive_count: number | null;
      top15_offensive_count: number | null;
    };
    classOverrides[r.draft_year] = {
      r1_offensive_count: r.r1_offensive_count,
      top15_offensive_count: r.top15_offensive_count,
    };
  }

  // Synthetic rookie tradeable entries — bridge the post-draft window
  // before nflverse publishes draft_picks.csv (typically 1-3 days). After
  // that, compute-dpv produces a real rookie prior in dpv_snapshots and
  // the synthetic entry is filtered out below by name match.
  const incomingClassYear = CURRENT_SEASON + 1;
  const [{ data: prospectRows }, sleeperTeams] = await Promise.all([
    sb
      .from("prospect_consensus")
      .select(
        "prospect_id, name, position, normalized_grade, projected_round, projected_overall_pick",
      )
      .eq("draft_year", incomingClassYear),
    fetchSleeperTeams(),
  ]);

  // team_seasons context for the latest available season per team — drives
  // the OL/QB-tier landing-spot multipliers inside computeRookiePrior. One
  // pull, indexed by team for O(1) lookup per rookie.
  const { data: teamSeasonRows } = await sb
    .from("team_seasons")
    .select("team, season, oline_composite_rank, qb_tier")
    .order("season", { ascending: false });
  const latestTeamCtx = new Map<
    string,
    { olineRank: number | null; qbTier: number | null }
  >();
  for (const row of (teamSeasonRows ?? []) as Array<{
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

  // Names that already have a real DPV snapshot (NFL or post-publish rookie
  // prior). Synthetic rookies whose normalized names match are dropped so
  // the calculator doesn't show two entries for the same player.
  const realPlayerNames = new Set<string>(
    nflPlayers.map((p) => normalizeName(p.name)),
  );

  const rookieInputs: RookieValueInput[] = [];
  for (const row of (prospectRows ?? []) as Array<{
    prospect_id: string;
    name: string;
    position: string | null;
    normalized_grade: number | null;
    projected_round: number | null;
    projected_overall_pick: number | null;
  }>) {
    if (!row.position) continue;
    if (realPlayerNames.has(normalizeName(row.name))) continue;
    const projectedRound =
      row.projected_round ?? roundFromOverallPick(row.projected_overall_pick);
    // Sleeper-resolved team: hits when Sleeper has them on a roster
    // (either drafted or picked up as a UDFA). Null means undrafted +
    // unsigned — we still emit a synthetic entry but it'll have no
    // landing-spot context.
    const team =
      sleeperTeams.get(sleeperTeamKey(row.name, row.position)) ?? null;
    const teamCtx = team ? latestTeamCtx.get(team) ?? null : null;
    rookieInputs.push({
      prospect: {
        prospectId: row.prospect_id,
        name: row.name,
        position: row.position,
        projectedRound,
        consensusGrade:
          row.normalized_grade !== null
            ? Number(row.normalized_grade)
            : null,
        // Pre-publish prospects don't carry birthdate, so age stays null
        // and the prior treats it as neutral. Real ageAtDraft folds in
        // once compute-dpv replaces the synthetic with a real prior.
        ageAtDraft: null,
        draftYear: incomingClassYear,
      },
      team,
      teamContext: teamCtx,
      scoringFormat: fmt,
      // Auto-detect Superflex from the league's roster_positions. SF/2-QB
      // leagues need rookie QB DPV inflated to compete with skill positions
      // — without this, Mendoza-tier QBs trade like a 2nd-rounder in SF.
      superflex: isSuperflexConstruction(leagueRosterPositions),
    });
  }
  const synthRookies = generateRookieTradeEntries(rookieInputs);

  // Picks: in league mode, use the synced league_picks table so each pick
  // is anchored to the team that actually owns it (after any chain of
  // trades from Sleeper). Outside league mode we fall back to the full
  // slot-level set, since there's no specific roster to filter against.
  //
  // Round-level vs slot-level: Sleeper's traded_picks endpoint exposes
  // round only (slot inside the round is a function of standings and
  // isn't determined until the regular season ends). The valuation
  // collapses to round-average DPV; the UI reflects that with "R1" /
  // "R2" / "R3" labels rather than "1.05".
  const pickEntries: TradePlayer[] =
    requestedLeague && leaguePicks.length > 0
      ? generateTeamRoundPicks(
          requestedLeague,
          leaguePicks,
          rosterOptions.map((r) => ({
            rosterId: r.rosterId,
            ownerName: r.ownerName,
            teamName: r.teamName,
          })),
          new Date(),
          classOverrides,
        )
      : generatePickPlayers(new Date(), classOverrides);

  // Merge picks + synthetic rookies into the tradeable pool. NFL players,
  // synthetic rookies, and rookie picks are ranked together by DPV so the
  // search dropdown blends them naturally.
  const players: TradePlayer[] = [
    ...nflPlayers,
    ...synthRookies,
    ...pickEntries,
  ].sort((a, b) => b.dpv - a.dpv);

  // League-aware position scarcity. Replacement cliff is computed from the
  // *NFL pool only* (synthetic rookies + picks would distort the cliff for
  // a position that hasn't seen rookies grade out yet). Default 12-team
  // 1-QB build kicks in when no league is selected or pre-roster_positions
  // sync.
  const { replacement, teamCount, isDefault: isDefaultConstruction } =
    leagueReplacementDPV(
      nflPlayers,
      leagueRosterPositions,
      leagueTotalRosters,
    );

  const fromId = fromRosterId ? Number(fromRosterId) : null;
  const toId = toRosterId ? Number(toRosterId) : null;

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Trade Calculator
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Add players to each side and get a verdict based on PYV totals,
          scarcity, and age profile.
          {leagueName && (
            <span className="ml-1 text-zinc-400">
              · League:{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {leagueName}
              </span>
            </span>
          )}
        </p>
      </div>

      <ToolTabs tool="calc" requestedLeague={requestedLeague} fmt={sp.fmt} />

      {!isPro && (
        <div className="mb-4 rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 px-3 py-2 text-xs text-zinc-600 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            Pro:
          </span>{" "}
          League-aware mode (per-team rosters + traded picks) and Buy/Sell
          market signals.{" "}
          <Link
            href="/pricing"
            className="font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
          >
            Upgrade →
          </Link>
        </div>
      )}

      <TradeCalculator
        players={players}
        fmt={fmt}
        leagueId={requestedLeague}
        rosterOptions={rosterOptions}
        defaultFromRosterId={fromId && Number.isFinite(fromId) ? fromId : null}
        defaultToRosterId={toId && Number.isFinite(toId) ? toId : null}
        defaultGiveIds={giveIds}
        defaultReceiveIds={receiveIds}
        replacement={replacement}
        replacementContext={{
          teamCount,
          rosterPositions: leagueRosterPositions,
          isDefault: isDefaultConstruction,
        }}
      />
    </div>
  );
}

// ---- Tool switcher --------------------------------------------------------
//
// Server component — preserves the rest of the URL state when switching
// tabs (selected league, scoring format) so the user doesn't lose context
// flipping between tools.

function ToolTabs({
  tool,
  requestedLeague,
  fmt,
}: {
  tool: "calc" | "multi";
  requestedLeague: string | null;
  fmt: string | undefined;
}) {
  function href(target: "calc" | "multi"): string {
    const p = new URLSearchParams();
    p.set("tool", target);
    if (requestedLeague) p.set("league", requestedLeague);
    if (fmt) p.set("fmt", fmt);
    return `/trade?${p.toString()}`;
  }
  return (
    <div className="mb-5 flex flex-wrap gap-1 border-b border-zinc-200 dark:border-zinc-800">
      <Link
        href={href("calc")}
        className={
          "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors " +
          (tool === "calc"
            ? "border-emerald-500 text-zinc-900 dark:text-zinc-100"
            : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
        }
      >
        Calculator
      </Link>
      <Link
        href={href("multi")}
        className={
          "px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors " +
          (tool === "multi"
            ? "border-emerald-500 text-zinc-900 dark:text-zinc-100"
            : "border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200")
        }
      >
        Multi-Team Analyzer
        <span className="ml-1.5 inline-block rounded bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide">
          Pro
        </span>
      </Link>
    </div>
  );
}
