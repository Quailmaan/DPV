"use server";

// Server-side data plumbing for the multi-team trade analyzer.
//
// Two responsibilities:
//   1. Hydrate a league: rosters, current player ownership, picks, and
//      every player's PYV/market/yearsPro snapshot. This is what feeds
//      the client-side asset pickers.
//   2. Run the deterministic analysis. The pricing function is pure —
//      this action just resolves IDs to live snapshots and forwards.
//
// Both gate on Pro tier. Free users will never reach these actions
// because the UI hides the analyzer, but defense-in-depth: a curl'd
// request still gets refused.

import { redirect } from "next/navigation";
import { getCurrentTier } from "@/lib/billing/tier";
import { createServerClient } from "@/lib/supabase/server";
import { buildMarketDeltaMap } from "@/lib/dpv/marketDelta";
import { CURRENT_SEASON } from "@/lib/dpv/constants";
import {
  generateTeamRoundPicks,
  type LeaguePickRow,
} from "@/lib/picks/values";
import type { ScoringFormat } from "@/lib/dpv/types";
import { priceTrade } from "@/lib/multi-trade/pricing";
import type {
  AnalyzeTradeInput,
  AnalyzeTradeResult,
  AssetSnapshot,
  PricingContext,
  RosterLabel,
} from "@/lib/multi-trade/types";

// ---- Public types ---------------------------------------------------------

export type LeagueOption = {
  leagueId: string;
  name: string;
  scoringFormat: ScoringFormat;
};

export type AnalyzerRosterAsset = {
  assetId: string;
  kind: "player" | "pick";
  name: string;
  position: string;
  team: string | null;
  age: number | null;
  pyv: number;
  /** Already scaled into DPV space using the league-format-wide k. */
  scaledMarket: number | null;
  tier: string;
};

export type AnalyzerRoster = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  assets: AnalyzerRosterAsset[];
};

export type AnalyzerLeagueData = {
  leagueId: string;
  leagueName: string;
  scoringFormat: ScoringFormat;
  /** Global market scale factor applied to display values. */
  k: number;
  rosters: AnalyzerRoster[];
};

// ---- Helpers --------------------------------------------------------------

function isScoringFormat(v: unknown): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

function approxYearsPro(birthdate: string | null, position: string): number {
  if (!birthdate) return 0;
  const ms = Date.now() - new Date(birthdate).getTime();
  const age = ms / (365.25 * 24 * 3600 * 1000);
  const baseAge = position === "QB" ? 23 : 22;
  return Math.max(0, Math.floor(age - baseAge));
}

function ageInYears(birthdate: string | null): number | null {
  if (!birthdate) return null;
  const ms = Date.now() - new Date(birthdate).getTime();
  return ms / (365.25 * 24 * 3600 * 1000);
}

// ---- list user's synced leagues -------------------------------------------

export async function listMyLeaguesForAnalyzer(): Promise<LeagueOption[]> {
  const tier = await getCurrentTier();
  if (tier.tier !== "pro") return [];

  const sb = await createServerClient();
  const { data: links } = await sb
    .from("user_leagues")
    .select("league_id");
  if (!links || links.length === 0) return [];

  const ids = links.map((l) => l.league_id);
  const { data: leagues } = await sb
    .from("leagues")
    .select("league_id, name, scoring_format")
    .in("league_id", ids);
  if (!leagues) return [];

  const out: LeagueOption[] = [];
  for (const l of leagues) {
    if (!isScoringFormat(l.scoring_format)) continue;
    out.push({
      leagueId: l.league_id,
      name: l.name ?? "League",
      scoringFormat: l.scoring_format,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---- load full analyzer data for a league ---------------------------------

export async function loadAnalyzerLeague(
  leagueId: string,
): Promise<AnalyzerLeagueData | { error: string }> {
  const tier = await getCurrentTier();
  if (tier.tier !== "pro") {
    return { error: "Pro membership required." };
  }

  const sb = await createServerClient();

  // Authorize: the user must have this league linked via user_leagues.
  // RLS would also block cross-user reads, but this surfaces a friendly
  // error instead of silent empty state.
  const { data: link } = await sb
    .from("user_leagues")
    .select("league_id")
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!link) {
    return { error: "League not found in your synced leagues." };
  }

  const [leagueRes, rostersRes, picksRes] = await Promise.all([
    sb
      .from("leagues")
      .select("league_id, name, scoring_format")
      .eq("league_id", leagueId)
      .maybeSingle(),
    sb
      .from("league_rosters")
      .select("roster_id, owner_display_name, team_name, player_ids")
      .eq("league_id", leagueId)
      .order("roster_id", { ascending: true }),
    sb
      .from("league_picks")
      .select("season, round, original_roster_id, owner_roster_id")
      .eq("league_id", leagueId),
  ]);

  if (!leagueRes.data) return { error: "League not found." };
  const fmt = isScoringFormat(leagueRes.data.scoring_format)
    ? leagueRes.data.scoring_format
    : "HALF_PPR";

  const rosterRows = (rostersRes.data ?? []) as Array<{
    roster_id: number;
    owner_display_name: string | null;
    team_name: string | null;
    player_ids: string[];
  }>;
  const pickRows = (picksRes.data ?? []) as LeaguePickRow[];

  // Pull DPV + market for the format. We pull the FULL pool to compute
  // the global k correctly — restricting to just league players would
  // bias k toward whichever positions happen to be rostered.
  const [{ data: dpvRows }, { data: mktRows }] = await Promise.all([
    sb
      .from("dpv_snapshots")
      .select(
        "player_id, dpv, tier, players(name, position, current_team, birthdate)",
      )
      .eq("scoring_format", fmt),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", fmt)
      .eq("source", "fantasycalc"),
  ]);

  const mktByPid = new Map<string, number>();
  for (const m of mktRows ?? []) {
    if (m.market_value_normalized !== null) {
      mktByPid.set(m.player_id, Number(m.market_value_normalized));
    }
  }

  type PlayerRow = {
    pid: string;
    name: string;
    position: string;
    team: string | null;
    birthdate: string | null;
    pyv: number;
    market: number | null;
    tier: string;
  };
  const players: PlayerRow[] = [];
  for (const r of dpvRows ?? []) {
    if (!r.players) continue;
    const p = r.players as unknown as {
      name: string;
      position: string;
      current_team: string | null;
      birthdate: string | null;
    };
    players.push({
      pid: r.player_id,
      name: p.name,
      position: p.position,
      team: p.current_team ?? null,
      birthdate: p.birthdate,
      pyv: r.dpv,
      market: mktByPid.get(r.player_id) ?? null,
      tier: r.tier,
    });
  }

  // Compute global k: sum DPV / sum market over the intersection. Same
  // formula the league page uses to surface scaled market in tooltips.
  let dpvSum = 0;
  let mktSum = 0;
  for (const p of players) {
    if (p.market === null) continue;
    dpvSum += p.pyv;
    mktSum += p.market;
  }
  const k = mktSum > 0 ? dpvSum / mktSum : 1;

  // Per-position rank delta — feeds the sell-window logic for each player.
  const deltaById = buildMarketDeltaMap(
    players.map((p) => ({
      id: p.pid,
      position: p.position,
      dpv: p.pyv,
      market: p.market,
    })),
  );

  const playerById = new Map<string, PlayerRow>();
  for (const p of players) playerById.set(p.pid, p);

  // Pull the same class_strength rows the trade page uses so the pick
  // valuations match exactly. Missing years default to neutral.
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

  // Pick entries scoped to this league (origin-aware, owner-aware).
  const pickPlayers = generateTeamRoundPicks(
    leagueId,
    pickRows,
    rosterRows.map((r) => ({
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
    })),
    new Date(),
    classOverrides,
  );

  // Build per-roster asset list: the player_ids the team owns plus any
  // picks where ownerRosterId matches.
  const rosters: AnalyzerRoster[] = rosterRows.map((r) => {
    const ownerName = r.owner_display_name ?? `Team ${r.roster_id}`;
    const teamName = r.team_name ?? null;

    const playerAssets: AnalyzerRosterAsset[] = [];
    for (const pid of r.player_ids ?? []) {
      const p = playerById.get(pid);
      if (!p) continue; // free agent or filtered position; skip
      const scaledMarket = p.market !== null ? p.market * k : null;
      playerAssets.push({
        assetId: p.pid,
        kind: "player",
        name: p.name,
        position: p.position,
        team: p.team,
        age: ageInYears(p.birthdate),
        pyv: p.pyv,
        scaledMarket,
        tier: p.tier,
      });
    }

    const pickAssets: AnalyzerRosterAsset[] = pickPlayers
      .filter((pk) => pk.ownerRosterId === r.roster_id)
      .map((pk) => ({
        assetId: pk.id,
        kind: "pick",
        name: pk.name,
        position: "PICK",
        team: pk.team,
        age: null,
        pyv: pk.dpv,
        scaledMarket: pk.dpv, // picks contribute equally to both axes
        tier: pk.tier,
      }));

    // Order: picks last, players sorted by PYV desc. The picker UI also
    // sorts on the client, but a sane default makes typeahead-free
    // browsing pleasant.
    playerAssets.sort((a, b) => b.pyv - a.pyv);
    pickAssets.sort((a, b) => b.pyv - a.pyv);

    return {
      rosterId: r.roster_id,
      ownerName,
      teamName,
      assets: [...playerAssets, ...pickAssets],
    };
  });

  // Suppress the unused-variable warning for CURRENT_SEASON; we don't
  // need it directly here but its constant ensures pick-window logic
  // is in sync with the rest of the app via generateTeamRoundPicks.
  void CURRENT_SEASON;
  void deltaById;

  return {
    leagueId,
    leagueName: leagueRes.data.name ?? "League",
    scoringFormat: fmt,
    k,
    rosters,
  };
}

// ---- run analysis ---------------------------------------------------------

export async function analyzeMultiTrade(
  input: AnalyzeTradeInput,
): Promise<AnalyzeTradeResult | { error: string }> {
  const tier = await getCurrentTier();
  if (tier.tier !== "pro") {
    return { error: "Pro membership required." };
  }

  // Basic input shape validation. The UI prevents bad shapes, but a
  // direct API hit shouldn't crash — it should refuse with a clear
  // message.
  if (!input.leagueId) return { error: "Missing league." };
  if (input.teams.length < 2)
    return { error: "Need at least 2 teams in a trade." };
  if (input.teams.length > 6)
    return { error: "Trades are capped at 6 teams." };
  if (input.movements.length === 0)
    return { error: "Add at least one asset movement." };

  // Authorize league access (same RLS-friendly soft check as the loader).
  const sb = await createServerClient();
  const { data: link } = await sb
    .from("user_leagues")
    .select("league_id")
    .eq("league_id", input.leagueId)
    .maybeSingle();
  if (!link) return { error: "League not in your synced leagues." };

  // Re-hydrate the same data the loader produced. Doing it server-side
  // is the only way to trust prices — the client could send anything.
  const data = await loadAnalyzerLeague(input.leagueId);
  if ("error" in data) return data;

  const teamRosterIds = new Set(input.teams.map((t) => t.rosterId));

  // Build the snapshot maps the pricing function expects.
  const assetsById = new Map<string, AssetSnapshot>();
  const rostersById = new Map<number, RosterLabel>();
  for (const r of data.rosters) {
    rostersById.set(r.rosterId, {
      rosterId: r.rosterId,
      ownerName: r.ownerName,
      teamName: r.teamName,
      label: r.teamName?.trim() || r.ownerName,
    });
    for (const a of r.assets) {
      // marketDelta + birthdate-derived metadata aren't on AnalyzerRosterAsset
      // (it's the lean UI payload). Reconstitute what pricing needs.
      assetsById.set(a.assetId, {
        assetId: a.assetId,
        kind: a.kind,
        name: a.name,
        position: a.position,
        team: a.team,
        age: a.age,
        yearsPro: a.kind === "player" ? approxYearsProFromAge(a.age, a.position) : 0,
        pyv: a.pyv,
        marketRaw: a.scaledMarket !== null ? a.scaledMarket / data.k : null,
        marketDelta: null,
      });
    }
  }

  // Need real marketDelta for sell-window verdicts. Fetch once for the
  // assets actually involved in the trade — cheaper than passing the
  // full delta map through every load.
  const involvedPids = input.movements
    .map((m) => assetsById.get(m.assetId))
    .filter((a): a is AssetSnapshot => !!a && a.kind === "player")
    .map((a) => a.assetId);
  if (involvedPids.length > 0) {
    const [{ data: deltaSnaps }, { data: deltaMkt }] = await Promise.all([
      sb
        .from("dpv_snapshots")
        .select("player_id, dpv, players(position)")
        .eq("scoring_format", data.scoringFormat),
      sb
        .from("market_values")
        .select("player_id, market_value_normalized")
        .eq("scoring_format", data.scoringFormat)
        .eq("source", "fantasycalc"),
    ]);
    const mktMap = new Map<string, number>();
    for (const m of deltaMkt ?? []) {
      if (m.market_value_normalized !== null) {
        mktMap.set(m.player_id, Number(m.market_value_normalized));
      }
    }
    const rankRows = (deltaSnaps ?? [])
      .filter((r) => r.players)
      .map((r) => {
        const p = r.players as unknown as { position: string };
        return {
          id: r.player_id,
          position: p.position,
          dpv: r.dpv,
          market: mktMap.get(r.player_id) ?? null,
        };
      });
    const deltas = buildMarketDeltaMap(rankRows);
    for (const pid of involvedPids) {
      const snap = assetsById.get(pid);
      if (snap) snap.marketDelta = deltas.get(pid) ?? null;
    }
  }

  // Validate every movement: asset must exist, fromRoster must own it,
  // both rosters must be in the trade.
  for (const m of input.movements) {
    if (!teamRosterIds.has(m.fromRosterId)) {
      return { error: `Movement source roster ${m.fromRosterId} is not in the trade.` };
    }
    if (!teamRosterIds.has(m.toRosterId)) {
      return { error: `Movement destination roster ${m.toRosterId} is not in the trade.` };
    }
    if (m.fromRosterId === m.toRosterId) {
      return { error: `An asset can't move from a team to itself.` };
    }
    const snap = assetsById.get(m.assetId);
    if (!snap) {
      return { error: `Asset ${m.assetId} not found in this league.` };
    }
    // Ownership check: confirm fromRoster actually has this asset.
    const owner = data.rosters.find((r) =>
      r.assets.some((a) => a.assetId === m.assetId),
    );
    if (!owner || owner.rosterId !== m.fromRosterId) {
      return {
        error: `${snap.name} is not owned by the source roster.`,
      };
    }
  }

  const ctx: PricingContext = {
    k: data.k,
    assetsById,
    rostersById,
  };

  return priceTrade(input, ctx);
}

// ---- internal helpers -----------------------------------------------------

// We don't keep birthdates around on AnalyzerRosterAsset (smaller payload)
// — recover yearsPro from age, since we already strip birthdate to age.
function approxYearsProFromAge(
  age: number | null,
  position: string,
): number {
  if (age === null) return 0;
  const baseAge = position === "QB" ? 23 : 22;
  return Math.max(0, Math.floor(age - baseAge));
}

// Re-export a redirect helper if any caller wants to bounce free users.
export async function bounceIfNotPro(redirectTo: string) {
  const tier = await getCurrentTier();
  if (tier.tier !== "pro") redirect(redirectTo);
}
