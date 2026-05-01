// Sleeper transactions fetcher. Used by the weekly digest to find the
// biggest trade in a league over the last ~7 days and identify the
// PYV winner (whoever got the higher net PYV swap).
//
// Sleeper API:
//   - GET /v1/state/nfl          → { season, week, season_type }
//   - GET /v1/league/{id}/transactions/{week}
//
// Transactions on Sleeper are partitioned by NFL "round" / week. In
// the regular season this is weeks 1-18. In the offseason Sleeper
// keeps the league at week 18 (or whatever the most recent regular-
// season week was), so we query that bucket plus one prior to cover
// any cross-week trades that landed near the boundary.
//
// Each trade transaction has:
//   - type: "trade"
//   - roster_ids: number[]               — rosters involved
//   - adds: Record<player_id, roster_id> — who got which player
//   - drops: Record<player_id, roster_id> — original owner per dropped player
//   - draft_picks: array of pick movements — { season, round,
//     roster_id (new owner), previous_owner_id (old owner) }
//   - created: epoch milliseconds
//
// Picks contribute to PYV scoring via the same round-average curve
// the trade calculator uses (lib/picks/constants.pickDpv averaged
// across slots 1-12, since Sleeper trades carry round granularity
// only — actual draft slot isn't determined until standings finalize).
// 4th-round and later picks have negligible PYV in our model and
// are skipped so they don't add noise.

import { currentPickWindow, pickDpv } from "../picks/constants";

const SLEEPER_BASE = "https://api.sleeper.app/v1";

// Average PYV across all 12 slots in a given (year, round). Mirrors
// the round-level valuation used by the trade calculator and the
// digest's trade-partners section. No class-strength overrides — the
// digest doesn't load that data; neutral is acceptable for "biggest
// trade" scoring since both sides of the trade get the same valuation.
function pickPyvForRound(season: number, round: 1 | 2 | 3): number {
  const [base] = currentPickWindow(new Date());
  let sum = 0;
  let n = 0;
  for (let slot = 1; slot <= 12; slot++) {
    const v = pickDpv(season, round, slot, base);
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? Math.round(sum / n) : 0;
}

type SleeperDraftPick = {
  // Sleeper sometimes encodes season as a string ("2026"), sometimes
  // as a number depending on which endpoint you hit. Tolerate both.
  season: string | number;
  round: number;
  // The roster receiving the pick AFTER this trade.
  roster_id: number;
  // The roster that owned it BEFORE the trade — i.e. the side sending it.
  previous_owner_id?: number;
  owner_id?: number;
};

type SleeperTransaction = {
  transaction_id: string;
  type: string;
  status: string;
  created: number;
  roster_ids: number[];
  adds: Record<string, number> | null;
  drops: Record<string, number> | null;
  draft_picks: SleeperDraftPick[] | null;
};

type NflState = { season: string; week: number; season_type: string };

export type LeagueTradeSummary = {
  /** Total absolute PYV moved across the trade — sum of PYV given by
   *  one side. The "biggest" trade is the one with the highest value here. */
  totalPyvSwapped: number;
  /** Winning roster (highest net PYV gain). Null if a tie or computation failed. */
  winnerRosterId: number | null;
  /** Net PYV the winner gained beyond what they gave up. */
  winnerNetPyv: number;
  /** Players the winner received (with PYV). */
  winnerReceived: { name: string; position: string; pyv: number }[];
  /** Players the winner sent. */
  winnerSent: { name: string; position: string; pyv: number }[];
  /** Other-side roster id — useful for the digest narrative. */
  loserRosterId: number | null;
  /** Epoch millis when Sleeper recorded the trade. */
  createdAt: number;
};

export async function fetchNflState(): Promise<NflState | null> {
  try {
    const res = await fetch(`${SLEEPER_BASE}/state/nfl`, {
      // Sleeper API is unauthenticated; revalidate generously since
      // state changes once a week at most.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as NflState;
  } catch {
    return null;
  }
}

export async function fetchTransactions(
  leagueId: string,
  week: number,
): Promise<SleeperTransaction[]> {
  try {
    const res = await fetch(
      `${SLEEPER_BASE}/league/${leagueId}/transactions/${week}`,
      { next: { revalidate: 600 } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as SleeperTransaction[] | null;
    return data ?? [];
  } catch {
    return [];
  }
}

/**
 * Find the biggest player-for-player trade in a league within the
 * last `windowMs` (default 7 days). Returns null if no qualifying
 * trade exists. The "biggest" metric is total absolute PYV moved
 * across — better than counting players because it weights skill,
 * not roster spots.
 *
 * Caller passes in a player→PYV/name/position lookup so we don't
 * re-query dpv_snapshots from inside this helper. Keeps the IO
 * boundary narrow: this function only knows about Sleeper, and the
 * caller (digestData) wires in DPV.
 */
export async function findBiggestRecentTrade(
  leagueId: string,
  playerLookup: Map<
    string,
    { name: string; position: string; pyv: number }
  >,
  options: { windowMs?: number } = {},
): Promise<LeagueTradeSummary | null> {
  const windowMs = options.windowMs ?? 7 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - windowMs;

  // Pick the weeks to query. State endpoint tells us "current" week;
  // we also pull the prior week to catch trades that crossed the
  // Sunday-Monday boundary. State unavailable → conservative fallback
  // covering weeks 1, 18 (offseason bucket), and a few common values.
  const state = await fetchNflState();
  const weeksToQuery = state
    ? // Most leagues use Sunday or Tuesday as the trade-eligibility window.
      // Querying current and current-1 catches both.
      [state.week, Math.max(1, state.week - 1)]
    : [18, 1];

  const all: SleeperTransaction[] = [];
  for (const w of weeksToQuery) {
    const batch = await fetchTransactions(leagueId, w);
    all.push(...batch);
  }

  // Completed trades within the window. Picks are scored via the
  // round-average curve — most dynasty trades involve at least one
  // pick, so excluding them would silently hide ~80% of real trades.
  const eligible = all.filter(
    (t) => t.type === "trade" && t.status === "complete" && t.created >= cutoff,
  );
  if (eligible.length === 0) return null;

  type Scored = {
    summary: LeagueTradeSummary;
  };
  const scored: Scored[] = [];

  for (const t of eligible) {
    const adds = t.adds ?? {};
    const drops = t.drops ?? {};
    if (Object.keys(adds).length === 0) continue;

    // Build per-roster gain/loss totals + name lists.
    type SidePlayers = {
      received: { name: string; position: string; pyv: number }[];
      sent: { name: string; position: string; pyv: number }[];
    };
    const byRoster = new Map<number, SidePlayers>();
    const ensure = (rid: number) => {
      const ex = byRoster.get(rid);
      if (ex) return ex;
      const init: SidePlayers = { received: [], sent: [] };
      byRoster.set(rid, init);
      return init;
    };

    let skip = false;
    for (const [pid, rid] of Object.entries(adds)) {
      const info = playerLookup.get(pid);
      if (!info) {
        skip = true; // unknown player → can't score this trade reliably
        break;
      }
      ensure(rid).received.push(info);
    }
    if (skip) continue;
    for (const [pid, rid] of Object.entries(drops)) {
      const info = playerLookup.get(pid);
      if (!info) {
        skip = true;
        break;
      }
      ensure(rid).sent.push(info);
    }
    if (skip) continue;

    // Picks: each draft_picks entry represents one pick changing
    // hands. Score by the round-average curve (slot is unknown until
    // standings finalize). Skip rounds outside 1-3 — 4th+ have
    // negligible PYV in our model.
    for (const pick of t.draft_picks ?? []) {
      const season =
        typeof pick.season === "string"
          ? parseInt(pick.season, 10)
          : pick.season;
      if (!Number.isFinite(season)) continue;
      if (pick.round < 1 || pick.round > 3) continue;
      const pyv = pickPyvForRound(season, pick.round as 1 | 2 | 3);
      if (pyv <= 0) continue;
      const newOwner = pick.roster_id;
      const oldOwner = pick.previous_owner_id;
      if (newOwner === undefined || oldOwner === undefined) continue;
      const entry = {
        name: `${season} R${pick.round}`,
        position: "PICK",
        pyv,
      };
      ensure(newOwner).received.push(entry);
      ensure(oldOwner).sent.push(entry);
    }

    if (byRoster.size !== 2) continue; // ignore 3-team trades for v1

    // Score: each roster's net = received - sent. Total PYV swapped
    // is the sum of either side's "received" (they're equal up to
    // accounting noise — every player given is received elsewhere).
    let winnerRosterId: number | null = null;
    let winnerNet = -Infinity;
    let totalSwapped = 0;
    for (const [rid, sides] of byRoster) {
      const recv = sides.received.reduce((a, p) => a + p.pyv, 0);
      const sent = sides.sent.reduce((a, p) => a + p.pyv, 0);
      const net = recv - sent;
      totalSwapped = Math.max(totalSwapped, recv); // pick one side's gross
      if (net > winnerNet) {
        winnerNet = net;
        winnerRosterId = rid;
      }
    }
    if (winnerRosterId === null) continue;
    const loserRosterId =
      [...byRoster.keys()].find((r) => r !== winnerRosterId) ?? null;
    const winnerSide = byRoster.get(winnerRosterId)!;

    scored.push({
      summary: {
        totalPyvSwapped: Math.round(totalSwapped),
        winnerRosterId,
        winnerNetPyv: Math.round(winnerNet),
        winnerReceived: winnerSide.received,
        winnerSent: winnerSide.sent,
        loserRosterId,
        createdAt: t.created,
      },
    });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.summary.totalPyvSwapped - a.summary.totalPyvSwapped);
  return scored[0].summary;
}
