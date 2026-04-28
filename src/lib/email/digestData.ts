// Per-user digest data loader. Given a Supabase admin client and a
// signed-in user's id + username, this builds the `DigestInput.leagues`
// array that `buildWeeklyDigest()` consumes.
//
// We intentionally re-do the same data shaping the league page does
// (snapshots → market delta map → sell-window per player → focused
// roster + trade ideas → report card). The math is shared via the pure
// helpers; only the *loading* lives here.
//
// "Which roster is mine?" Read from `user_leagues.roster_id` — the user
// picks their team via the MyTeamPicker on /league/[id] and that pick
// persists. If the field is null (legacy rows pre-migration, or the user
// just hasn't picked yet) we fall back to a case-insensitive match of
// their Pylon `username` against `owner_display_name`. Still no match?
// Skip the league — better to ship a digest missing a league than one
// pinned to the wrong team.
//
// All Supabase calls use the admin client (bypasses RLS). The cron
// route is server-only and never exposes this data to a browser.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMarketDeltaMap } from "@/lib/dpv/marketDelta";
import {
  computeSellWindow,
  type Position as SellWindowPosition,
  type SellWindow,
} from "@/lib/dpv/sellWindow";
import {
  findTrades,
  type TradeFinderTeam,
  type TradeFinderPlayer,
  type TradePosition,
} from "@/lib/league/tradeFinder";
import {
  computeReportCards,
  type LeaguePick,
  type Position,
  type ReportPlayer,
  type RosterInput,
} from "@/lib/league/reportCard";
import type { ScoringFormat } from "@/lib/dpv/types";
import type { DigestLeague, DigestPlayer } from "./weeklyDigest";

type LeagueRow = {
  league_id: string;
  name: string;
  season: string;
  total_rosters: number;
  scoring_format: ScoringFormat;
  roster_positions: string[] | null;
};

type RosterRow = {
  league_id: string;
  roster_id: number;
  owner_display_name: string | null;
  team_name: string | null;
  player_ids: string[];
};

type Snap = {
  player_id: string;
  dpv: number;
  tier: string;
  players: {
    name: string;
    position: string;
    current_team: string | null;
    birthdate: string | null;
  } | null;
};

/**
 * Load digest-ready blocks for every league the user is subscribed to.
 * Skips leagues where we can't identify the user's roster — those leagues
 * are returned in `skippedLeagues` so the caller can surface them in
 * logs / a footer note.
 */
export async function loadDigestLeagues(
  sb: SupabaseClient,
  args: { userId: string; username: string },
): Promise<{
  leagues: DigestLeague[];
  skippedLeagues: { leagueId: string; leagueName: string; reason: string }[];
}> {
  const { data: subs } = await sb
    .from("user_leagues")
    .select("league_id, roster_id")
    .eq("user_id", args.userId);
  const subsRows = (subs ?? []) as Array<{
    league_id: string;
    roster_id: number | null;
  }>;
  if (subsRows.length === 0) {
    return { leagues: [], skippedLeagues: [] };
  }

  const out: DigestLeague[] = [];
  const skipped: {
    leagueId: string;
    leagueName: string;
    reason: string;
  }[] = [];

  for (const sub of subsRows) {
    const block = await loadOneLeague(
      sb,
      sub.league_id,
      args.username,
      sub.roster_id,
    );
    if (block.kind === "ok") {
      out.push(block.league);
    } else {
      skipped.push({
        leagueId: sub.league_id,
        leagueName: block.leagueName,
        reason: block.reason,
      });
    }
  }
  return { leagues: out, skippedLeagues: skipped };
}

type OneLeagueResult =
  | { kind: "ok"; league: DigestLeague }
  | { kind: "skip"; leagueName: string; reason: string };

async function loadOneLeague(
  sb: SupabaseClient,
  leagueId: string,
  username: string,
  pickedRosterId: number | null,
): Promise<OneLeagueResult> {
  const [leagueRes, rostersRes, picksRes] = await Promise.all([
    sb.from("leagues").select("*").eq("league_id", leagueId).maybeSingle(),
    sb
      .from("league_rosters")
      .select("*")
      .eq("league_id", leagueId)
      .order("roster_id", { ascending: true }),
    sb
      .from("league_picks")
      .select("season, round, owner_roster_id")
      .eq("league_id", leagueId),
  ]);

  if (!leagueRes.data) {
    return {
      kind: "skip",
      leagueName: leagueId,
      reason: "League row missing",
    };
  }
  const league = leagueRes.data as LeagueRow;
  const rosters = (rostersRes.data ?? []) as RosterRow[];
  const leaguePicks: LeaguePick[] = (
    (picksRes.data ?? []) as Array<{
      season: number;
      round: number;
      owner_roster_id: number;
    }>
  ).map((p) => ({
    season: p.season,
    round: p.round,
    ownerRosterId: p.owner_roster_id,
  }));

  // Resolve the focused roster. Prefer the persisted pick from
  // user_leagues; only fall back to username matching for legacy rows
  // (pre-picker users haven't opened /league/[id] since the column
  // shipped). When neither resolves, skip the league.
  let focusedRoster: RosterRow | undefined;
  if (pickedRosterId !== null) {
    focusedRoster = rosters.find((r) => r.roster_id === pickedRosterId);
  }
  if (!focusedRoster) {
    focusedRoster = rosters.find(
      (r) =>
        r.owner_display_name &&
        r.owner_display_name.toLowerCase() === username.toLowerCase(),
    );
  }
  if (!focusedRoster) {
    return {
      kind: "skip",
      leagueName: league.name,
      reason:
        "No team picked for this league. Visit /league/{id} and use the team picker.",
    };
  }

  // Load DPV + market values for the league's scoring format. Same shape
  // as the league page so all helpers feed off identical inputs.
  const [snapshotsRes, marketRes] = await Promise.all([
    sb
      .from("dpv_snapshots")
      .select(
        "player_id, dpv, tier, players(name, position, current_team, birthdate)",
      )
      .eq("scoring_format", league.scoring_format)
      .order("dpv", { ascending: false }),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", league.scoring_format)
      .eq("source", "fantasycalc"),
  ]);

  const snapshots = (snapshotsRes.data ?? []) as unknown as Snap[];
  const snapMap = new Map<string, Snap>(
    snapshots.map((s) => [s.player_id, s]),
  );

  const marketByPid = new Map<string, number>();
  for (const m of (marketRes.data ?? []) as Array<{
    player_id: string;
    market_value_normalized: number | null;
  }>) {
    if (m.market_value_normalized !== null) {
      marketByPid.set(m.player_id, Number(m.market_value_normalized));
    }
  }
  const marketDeltaInput = snapshots
    .map((s) => {
      if (!s.players) return null;
      return {
        id: s.player_id,
        position: s.players.position,
        dpv: Number(s.dpv),
        market: marketByPid.get(s.player_id) ?? null,
      };
    })
    .filter((x): x is {
      id: string;
      position: string;
      dpv: number;
      market: number | null;
    } => x !== null);
  const marketDeltaMap = buildMarketDeltaMap(marketDeltaInput);

  // Scale FantasyCalc market values to the DPV magnitude so the trade
  // finder can blend them with PYV. Same global mean-anchoring used on
  // the league page — keeps the digest's trade ideas in lockstep with
  // what the user sees on /league/[id].
  const scaledMarketByPid = new Map<string, number>();
  {
    let dpvSum = 0;
    let mktSum = 0;
    for (const s of marketDeltaInput) {
      if (s.market === null) continue;
      dpvSum += s.dpv;
      mktSum += s.market;
    }
    const k = mktSum > 0 ? dpvSum / mktSum : 1;
    for (const [pid, mv] of marketByPid.entries()) {
      scaledMarketByPid.set(pid, mv * k);
    }
  }

  // Per-player sell-window for every rostered player (across the whole
  // league — trade finder needs them too).
  const sellWindowByPlayer = new Map<string, SellWindow | null>();
  for (const r of rosters) {
    for (const pid of r.player_ids) {
      if (sellWindowByPlayer.has(pid)) continue;
      const s = snapMap.get(pid);
      if (!s || !s.players) {
        sellWindowByPlayer.set(pid, null);
        continue;
      }
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") {
        sellWindowByPlayer.set(pid, null);
        continue;
      }
      const bd = s.players.birthdate;
      const ageYears = bd
        ? (Date.now() - new Date(bd).getTime()) /
          (365.25 * 24 * 3600 * 1000)
        : null;
      sellWindowByPlayer.set(
        pid,
        computeSellWindow({
          position: pos as SellWindowPosition,
          age: ageYears,
          dpv: Number(s.dpv),
          marketDelta: marketDeltaMap.get(pid) ?? null,
        }),
      );
    }
  }

  // Per-roster summary: total DPV + per-position totals. Used for the
  // league-relative position averages the trade finder needs.
  type Summary = {
    rosterId: number;
    byPos: Record<TradePosition, number>;
  };
  const summaries: Summary[] = rosters.map((r) => {
    const byPos: Record<TradePosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const pid of r.player_ids) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position as TradePosition;
      if (!(pos in byPos)) continue;
      byPos[pos] += Number(s.dpv);
    }
    return { rosterId: r.roster_id, byPos };
  });

  const leaguePosAvg: Record<TradePosition, number> = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
  };
  for (const s of summaries) {
    leaguePosAvg.QB += s.byPos.QB;
    leaguePosAvg.RB += s.byPos.RB;
    leaguePosAvg.WR += s.byPos.WR;
    leaguePosAvg.TE += s.byPos.TE;
  }
  const nRosters = summaries.length || 1;
  leaguePosAvg.QB /= nRosters;
  leaguePosAvg.RB /= nRosters;
  leaguePosAvg.WR /= nRosters;
  leaguePosAvg.TE /= nRosters;

  // Approximate NFL years played from birthdate. Drives the PYV/market
  // blend in the trade finder — see league page for the same helper /
  // rationale (kept duplicated rather than extracted because the helper
  // is one-liner and the surface area is tiny).
  function approxYearsPro(
    birthdate: string | null,
    position: TradePosition,
  ): number {
    if (!birthdate) return 3;
    const age =
      (Date.now() - new Date(birthdate).getTime()) /
      (365.25 * 24 * 3600 * 1000);
    const baseAge = position === "QB" ? 23 : 22;
    return Math.max(0, Math.floor(age - baseAge));
  }

  // Build TradeFinderTeam shape per roster.
  function buildTradeFinderTeam(roster: RosterRow): TradeFinderTeam {
    const summary = summaries.find((s) => s.rosterId === roster.roster_id);
    const players: TradeFinderPlayer[] = [];
    for (const pid of roster.player_ids) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") {
        continue;
      }
      const tp = pos as TradePosition;
      players.push({
        playerId: pid,
        name: s.players.name,
        position: tp,
        dpv: Number(s.dpv),
        marketValue: scaledMarketByPid.get(pid) ?? null,
        yearsPro: approxYearsPro(s.players.birthdate, tp),
        sellWindow: sellWindowByPlayer.get(pid) ?? null,
      });
    }
    return {
      rosterId: roster.roster_id,
      ownerName: roster.owner_display_name ?? `Team ${roster.roster_id}`,
      teamName: roster.team_name,
      players,
      byPos: summary?.byPos ?? { QB: 0, RB: 0, WR: 0, TE: 0 },
    };
  }

  const myTeam = buildTradeFinderTeam(focusedRoster);
  const others = rosters
    .filter((r) => r.roster_id !== focusedRoster.roster_id)
    .map(buildTradeFinderTeam);

  // Top 2 trades — emails surface fewer than the on-page Trade Ideas
  // section so the digest stays scannable.
  const tradeIdeas = findTrades(myTeam, others, leaguePosAvg, { maxIdeas: 2 });

  // Top 3 SELL signals on the focused team. SELL_NOW first, then
  // SELL_SOON. The DigestPlayer shape strips the noisy fields the
  // template doesn't render.
  const topSells: DigestPlayer[] = myTeam.players
    .filter(
      (p) =>
        p.sellWindow?.verdict === "SELL_NOW" ||
        p.sellWindow?.verdict === "SELL_SOON",
    )
    .sort((a, b) => {
      const order = (v: string | undefined) =>
        v === "SELL_NOW" ? 0 : v === "SELL_SOON" ? 1 : 2;
      const ord = order(a.sellWindow?.verdict) - order(b.sellWindow?.verdict);
      if (ord !== 0) return ord;
      return b.dpv - a.dpv;
    })
    .slice(0, 3)
    .map((p) => ({
      name: p.name,
      position: p.position,
      dpv: p.dpv,
      // Non-null assertion: the filter above guarantees presence.
      sellWindow: p.sellWindow as SellWindow,
    }));

  // Report card for the focused team only — we don't need every team's
  // card in the email. computeReportCards needs ALL rosters (it
  // percentile-ranks within the league), so we run it across the league
  // and pluck the focused row.
  const picksByRoster = new Map<number, LeaguePick[]>();
  for (const p of leaguePicks) {
    const arr = picksByRoster.get(p.ownerRosterId) ?? [];
    arr.push(p);
    picksByRoster.set(p.ownerRosterId, arr);
  }
  const rosterInputs: RosterInput[] = rosters.map((r) => {
    const players: ReportPlayer[] = [];
    for (const pid of r.player_ids) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") {
        continue;
      }
      players.push({
        playerId: pid,
        name: s.players.name,
        position: pos as Position,
        birthdate: s.players.birthdate,
        dpv: Number(s.dpv),
      });
    }
    return {
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
      players,
      picks: picksByRoster.get(r.roster_id) ?? [],
    };
  });
  const cards = computeReportCards(rosterInputs, {
    rosterPositions: league.roster_positions,
    totalRosters: league.total_rosters,
  });
  const myCard = cards.find((c) => c.rosterId === focusedRoster.roster_id);
  if (!myCard) {
    return {
      kind: "skip",
      leagueName: league.name,
      reason: "Report card computation returned no row for focused roster",
    };
  }

  return {
    kind: "ok",
    league: {
      leagueId: league.league_id,
      leagueName: league.name,
      card: { composite: myCard.composite, verdict: myCard.verdict },
      topSells,
      topTrades: tradeIdeas,
    },
  };
}
