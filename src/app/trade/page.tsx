import { createServerClient } from "@/lib/supabase/server";
import type { ScoringFormat } from "@/lib/dpv/types";
import { generatePickPlayers } from "@/lib/picks/values";
import TradeCalculator, {
  type TradePlayer,
  type LeagueRosterOption,
} from "./TradeCalculator";

type SearchParams = Promise<{
  fmt?: string;
  league?: string;
  from?: string;
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
  const requestedLeague = sp.league ?? null;
  const fromRosterId = sp.from ?? null;

  const sb = createServerClient();

  let fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";
  let leagueName: string | null = null;
  let rosterOptions: LeagueRosterOption[] = [];

  if (requestedLeague) {
    const [leagueRes, rostersRes] = await Promise.all([
      sb.from("leagues").select("*").eq("league_id", requestedLeague).maybeSingle(),
      sb
        .from("league_rosters")
        .select(
          "roster_id, owner_display_name, team_name, player_ids",
        )
        .eq("league_id", requestedLeague)
        .order("roster_id", { ascending: true }),
    ]);
    if (leagueRes.data) {
      leagueName = leagueRes.data.name;
      // League format overrides search param so trade uses the right scoring.
      if (isScoringFormat(leagueRes.data.scoring_format)) {
        fmt = leagueRes.data.scoring_format;
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

  // Per-position rank deltas — only meaningful within the intersection of
  // players that have BOTH a DPV and a market value. A 5-rank gap at WR
  // means more than at TE because positions have different depths.
  const deltaById = new Map<string, number>();
  const positions = Array.from(new Set(pre.map((p) => p.position)));
  for (const pos of positions) {
    const inPos = pre.filter((p) => p.position === pos && p.market !== null);
    const dpvSorted = [...inPos].sort((a, b) => b.dpv - a.dpv);
    const mktSorted = [...inPos].sort(
      (a, b) => (b.market ?? 0) - (a.market ?? 0),
    );
    const dpvRank = new Map(dpvSorted.map((p, i) => [p.id, i + 1]));
    const mktRank = new Map(mktSorted.map((p, i) => [p.id, i + 1]));
    for (const p of inPos) {
      const dr = dpvRank.get(p.id);
      const mr = mktRank.get(p.id);
      if (dr === undefined || mr === undefined) continue;
      // Positive delta = DPV ranks higher (lower number) than market = Buy.
      deltaById.set(p.id, mr - dr);
    }
  }

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
      marketDelta: deltaById.get(p.id) ?? null,
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

  // Merge rookie picks into the tradeable pool. They're ranked alongside NFL
  // players by DPV so the search dropdown blends them naturally.
  const players: TradePlayer[] = [
    ...nflPlayers,
    ...generatePickPlayers(new Date(), classOverrides),
  ].sort((a, b) => b.dpv - a.dpv);

  const fromId = fromRosterId ? Number(fromRosterId) : null;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Trade Calculator
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Add players to each side and get a verdict based on DPV totals,
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
      <TradeCalculator
        players={players}
        fmt={fmt}
        leagueId={requestedLeague}
        rosterOptions={rosterOptions}
        defaultFromRosterId={fromId && Number.isFinite(fromId) ? fromId : null}
      />
    </div>
  );
}
