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
  type TradeFinderTeam,
  type TradeFinderPlayer,
  type TradePosition,
} from "@/lib/league/tradeFinder";
import { findBiggestRecentTrade } from "@/lib/sleeper/transactions";
import {
  computeReportCards,
  type LeaguePick,
  type Position,
  type ReportPlayer,
  type RosterInput,
} from "@/lib/league/reportCard";
import type { ScoringFormat } from "@/lib/dpv/types";
import type {
  DigestLeague,
  DigestLeagueLoser,
  DigestLeagueTrade,
  DigestMover,
  DigestPlayer,
  DigestPositionRank,
  DigestTradePartner,
} from "./weeklyDigest";

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
  function ageInYears(birthdate: string | null): number | null {
    if (!birthdate) return null;
    return (
      (Date.now() - new Date(birthdate).getTime()) /
      (365.25 * 24 * 3600 * 1000)
    );
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
        age: ageInYears(s.players.birthdate),
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

  // The on-page trade-finder produces specific "Send X → Receive Y"
  // ideas. The digest deliberately does NOT include these — feedback
  // says the email should tell the user WHICH POSITION to target,
  // and let them open the league page for specific names. The
  // weakest position + tradePartners section below carries that role.

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

  // ── Composite rank within the league ────────────────────────────
  // 1 = highest composite. Ties resolve by roster_id for stability.
  const cardRank =
    [...cards]
      .sort((a, b) => b.composite - a.composite || a.rosterId - b.rosterId)
      .findIndex((c) => c.rosterId === focusedRoster.roster_id) + 1;

  // ── Position strength: rank our roster at each position ────────
  // Sort all summaries by byPos[pos] descending; our index + 1 is the
  // rank. Surplus pct vs league-wide avg quantifies "how strong/weak."
  const positions: Array<"QB" | "RB" | "WR" | "TE"> = ["QB", "RB", "WR", "TE"];
  const positionRanks: DigestPositionRank[] = positions.map((pos) => {
    const sorted = [...summaries].sort(
      (a, b) => b.byPos[pos] - a.byPos[pos] || a.rosterId - b.rosterId,
    );
    const rank =
      sorted.findIndex((s) => s.rosterId === focusedRoster.roster_id) + 1;
    const my =
      summaries.find((s) => s.rosterId === focusedRoster.roster_id)?.byPos[
        pos
      ] ?? 0;
    const avg = leaguePosAvg[pos];
    // Avoid divide-by-zero when a brand-new league has no data yet.
    const deltaPct = avg > 0 ? Math.round(((my - avg) / avg) * 100) : 0;
    return {
      position: pos,
      rank,
      totalRosters: summaries.length,
      pyv: Math.round(my),
      deltaPct,
    };
  });
  // Strongest = lowest rank number; weakest = highest. Tie-break by
  // |deltaPct| so a tied rank still picks the more meaningful position.
  const strongest = [...positionRanks].sort(
    (a, b) => a.rank - b.rank || b.deltaPct - a.deltaPct,
  )[0];
  const weakest = [...positionRanks].sort(
    (a, b) => b.rank - a.rank || a.deltaPct - b.deltaPct,
  )[0];

  // ── Find the two most recent dpv_history snapshot dates ─────────
  // Shared between the focused-roster mover section and the league-
  // wide loser section. Determined via the focused roster (~25 players),
  // which keeps the result set small enough to reliably span both
  // dates inside Supabase's default 1000-row response cap. An earlier
  // version queried `select("snapshot_date").limit(200)` directly,
  // which silently broke when ~600 players × 1 date filled all 200
  // slots and the second-most-recent date never made it into the
  // result. Doing the date detection on a player-narrowed query
  // dodges that entirely.
  const focusedPlayerIds = focusedRoster.player_ids;
  const tenDaysAgoIso = new Date(
    Date.now() - 10 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const tenDaysAgoDate = tenDaysAgoIso.slice(0, 10);
  let currentDate: string | null = null;
  let priorDate: string | null = null;
  let focusedHist: { player_id: string; snapshot_date: string; dpv: number }[] =
    [];
  if (focusedPlayerIds.length > 0) {
    const { data: histRows } = await sb
      .from("dpv_history")
      .select("player_id, snapshot_date, dpv")
      .eq("scoring_format", league.scoring_format)
      .gte("snapshot_date", tenDaysAgoDate)
      .in("player_id", focusedPlayerIds)
      .order("snapshot_date", { ascending: false });
    focusedHist = (histRows ?? []) as typeof focusedHist;
    const datesDesc = [
      ...new Set(focusedHist.map((r) => r.snapshot_date)),
    ].sort((a, b) => (a < b ? 1 : -1));
    if (datesDesc.length >= 2) {
      currentDate = datesDesc[0];
      priorDate = datesDesc[1];
    }
  }

  // ── Week-over-week movers on the focused roster ─────────────────
  // Empty when dpv_history hasn't accumulated two snapshots yet
  // (brand-new account / cold start) — UI gracefully omits the section.
  let topRisers: DigestMover[] = [];
  let topFallers: DigestMover[] = [];
  if (currentDate && priorDate) {
    const byPlayerCurrent = new Map<string, number>();
    const byPlayerPrior = new Map<string, number>();
    for (const r of focusedHist) {
      if (r.snapshot_date === currentDate) {
        byPlayerCurrent.set(r.player_id, Number(r.dpv));
      } else if (r.snapshot_date === priorDate) {
        byPlayerPrior.set(r.player_id, Number(r.dpv));
      }
    }
    const movers: DigestMover[] = [];
    for (const pid of focusedPlayerIds) {
      const cur = byPlayerCurrent.get(pid);
      const prior = byPlayerPrior.get(pid);
      if (cur === undefined || prior === undefined) continue;
      const snap = snapMap.get(pid);
      if (!snap || !snap.players) continue;
      const delta = cur - prior;
      if (delta === 0) continue;
      movers.push({
        name: snap.players.name,
        position: snap.players.position,
        dpv: cur,
        delta,
      });
    }
    topRisers = movers
      .filter((m) => m.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, 3);
    topFallers = movers
      .filter((m) => m.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 3);
  }

  // ── League-wide biggest PYV drop this week ──────────────────────
  // Reuses the shared currentDate / priorDate determined above. Pulls
  // ALL rostered players' rows on those two specific dates, computes
  // each delta, picks the most negative.
  let leagueLoser: DigestLeagueLoser | null = null;
  {
    const allRosteredIds = new Set<string>();
    const ownerOfPlayer = new Map<string, string>();
    for (const r of rosters) {
      for (const pid of r.player_ids) {
        allRosteredIds.add(pid);
        ownerOfPlayer.set(
          pid,
          r.owner_display_name ?? `Team ${r.roster_id}`,
        );
      }
    }
    if (allRosteredIds.size > 0 && currentDate && priorDate) {
      {
        // Don't filter by player_id at the query layer. With 12 teams ×
        // ~25 roster spots ≈ 300 ids, Supabase's `.in()` URL-based
        // filter can quietly exceed the request URL length limit and
        // silently return zero rows (no thrown error). Pulling all
        // rows for the two dates and filtering to allRosteredIds in
        // memory is ~600 rows × 2 dates = 1.2k rows, well inside
        // Supabase's default 1000-row page when split per date.
        const [curRes, priorRes] = await Promise.all([
          sb
            .from("dpv_history")
            .select("player_id, dpv")
            .eq("scoring_format", league.scoring_format)
            .eq("snapshot_date", currentDate),
          sb
            .from("dpv_history")
            .select("player_id, dpv")
            .eq("scoring_format", league.scoring_format)
            .eq("snapshot_date", priorDate),
        ]);
        const curRows = (curRes.data ?? []) as {
          player_id: string;
          dpv: number;
        }[];
        const priorRows = (priorRes.data ?? []) as {
          player_id: string;
          dpv: number;
        }[];
        const cur = new Map<string, number>();
        const prior = new Map<string, number>();
        for (const r of curRows) {
          if (allRosteredIds.has(r.player_id)) cur.set(r.player_id, r.dpv);
        }
        for (const r of priorRows) {
          if (allRosteredIds.has(r.player_id)) prior.set(r.player_id, r.dpv);
        }
        let worstPid: string | null = null;
        let worstDelta = 0;
        for (const pid of allRosteredIds) {
          const c = cur.get(pid);
          const p = prior.get(pid);
          if (c === undefined || p === undefined) continue;
          const d = c - p;
          if (d < worstDelta) {
            worstDelta = d;
            worstPid = pid;
          }
        }
        if (worstPid !== null) {
          const snap = snapMap.get(worstPid);
          if (snap?.players) {
            leagueLoser = {
              name: snap.players.name,
              position: snap.players.position,
              ownerName: ownerOfPlayer.get(worstPid) ?? "(unknown)",
              delta: Math.round(worstDelta),
              dpv: cur.get(worstPid) ?? Number(snap.dpv),
            };
          }
        }
      }
    }
  }

  // ── Biggest trade in the league this week ──────────────────────
  // Sleeper transactions API + our PYV map → who won the swap. The
  // helper handles offseason gracefully (returns null when no recent
  // trades qualify) so we just check for null at render time.
  let biggestTrade: DigestLeagueTrade | null = null;
  {
    const playerLookup = new Map<
      string,
      { name: string; position: string; pyv: number }
    >();
    for (const [pid, snap] of snapMap.entries()) {
      if (!snap.players) continue;
      playerLookup.set(pid, {
        name: snap.players.name,
        position: snap.players.position,
        pyv: Math.round(Number(snap.dpv)),
      });
    }
    const summary = await findBiggestRecentTrade(league.league_id, playerLookup);
    if (summary && summary.winnerRosterId !== null) {
      const winnerName =
        rosters.find((r) => r.roster_id === summary.winnerRosterId)
          ?.owner_display_name ?? `Team ${summary.winnerRosterId}`;
      const loserName =
        summary.loserRosterId !== null
          ? rosters.find((r) => r.roster_id === summary.loserRosterId)
              ?.owner_display_name ?? `Team ${summary.loserRosterId}`
          : "(unknown)";
      biggestTrade = {
        totalPyvSwapped: summary.totalPyvSwapped,
        winnerOwner: winnerName,
        winnerNetPyv: summary.winnerNetPyv,
        winnerReceived: summary.winnerReceived.map((p) => ({
          name: p.name,
          position: p.position,
          pyv: Math.round(p.pyv),
        })),
        winnerSent: summary.winnerSent.map((p) => ({
          name: p.name,
          position: p.position,
          pyv: Math.round(p.pyv),
        })),
        loserOwner: loserName,
      };
    }
  }

  // ── Trade partners at our weakest position ──────────────────────
  // Other rosters with above-average PYV at our weakest position get
  // listed with their top 2-3 players at that slot. Useful even when
  // findTrades only returns 0-1 ideas (low-confidence weeks) — the
  // user still sees who to message.
  const tradePartners: DigestTradePartner[] = (() => {
    const targetPos = weakest.position;
    const avg = leaguePosAvg[targetPos];
    const partners: DigestTradePartner[] = [];
    for (const other of others) {
      const otherPyv = other.byPos[targetPos];
      if (avg <= 0 || otherPyv <= avg * 1.05) continue; // need real surplus
      const otherPlayers = other.players
        .filter((p) => p.position === targetPos)
        .sort((a, b) => b.dpv - a.dpv)
        .slice(0, 3)
        .map((p) => ({ name: p.name, dpv: Math.round(p.dpv) }));
      if (otherPlayers.length === 0) continue;
      partners.push({
        ownerName: other.ownerName,
        topPlayers: otherPlayers,
        surplusPct: Math.round(((otherPyv - avg) / avg) * 100),
      });
    }
    return partners
      .sort((a, b) => b.surplusPct - a.surplusPct)
      .slice(0, 3);
  })();

  return {
    kind: "ok",
    league: {
      leagueId: league.league_id,
      leagueName: league.name,
      card: { composite: myCard.composite, verdict: myCard.verdict },
      cardRank,
      strongest,
      weakest,
      topRisers,
      topFallers,
      tradePartners,
      biggestTrade,
      leagueLoser,
      topSells,
    },
  };
}
