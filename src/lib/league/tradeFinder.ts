// Trade finder — surface 1-for-1 trade ideas for a focused team.
//
// The job here is *very* specific: given a focused roster, find the
// few trades in this league that are simultaneously
//
//   1. Fair on value — DPV within ~30% of each other (not lopsided)
//   2. Aligned with sell-window — I'm giving up someone past peak,
//      receiving someone in or before their prime
//   3. Aligned with positional need — I'm short at the position I
//      receive, the partner is deep at the position they receive
//
// Each of those alone produces noise. Combined, you get the trades
// where every party has a reason to talk. We surface 5 max — a list
// any longer reads as spam.
//
// All scoring weights are intentionally small magic numbers. The goal
// is *ordering*, not calibration: as long as the ranked top-5 looks
// reasonable to a person, the absolute scores are throwaway.
//
// This is a pure function with no I/O. The caller loads rosters + DPVs
// + market deltas + sell-windows from the page, hands them in, gets
// trade ideas back. The page does the rendering.

import type { SellWindow } from "@/lib/dpv/sellWindow";

export type TradePosition = "QB" | "RB" | "WR" | "TE";

export type TradeFinderPlayer = {
  playerId: string;
  name: string;
  position: TradePosition;
  dpv: number;
  /** Null when not in our position-aging coverage; trade finder skips them. */
  sellWindow: SellWindow | null;
};

export type TradeFinderTeam = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  players: TradeFinderPlayer[];
  byPos: Record<TradePosition, number>;
};

export type TradeIdea = {
  give: TradeFinderPlayer;
  receive: TradeFinderPlayer;
  partnerRosterId: number;
  partnerName: string;
  partnerTeamName: string | null;
  /** receive.dpv − give.dpv; positive = focused team gains DPV. */
  myDpvDelta: number;
  /** 1-sentence explanation suitable for the card subtitle. */
  rationale: string;
  /** Internal score; not user-facing — used for ranking. */
  score: number;
};

const POSITIONS: TradePosition[] = ["QB", "RB", "WR", "TE"];

// Ignore trades where DPV gap exceeds this fraction of the larger
// player. Tightened from 0.30 to 0.15 — the old gate let through trades
// like "give Justin Jefferson, receive Daniel Jones" because the % gap
// was technically under 30%. 15% keeps the win-now-premium use case
// (vet for younger asset) without surfacing trades a manager would
// laugh at.
const MAX_DPV_IMBALANCE = 0.15;

// Hard floor on what the focused team can give up net. Even if a trade
// passes the % gate, suggesting "give up 749 PYV more than you get
// back" is bad UX — the percentage gate alone is too permissive when
// both players are 4000+ PYV. 250 PYV is roughly "one tier" of value,
// which is the most we'll let a sell-window trade swing.
const MAX_ABS_DPV_GIVEUP = 250;

// Position need threshold below which we don't count a position as a
// "real" need. Stops a roster that's 1% below average from being
// flagged as needing the position.
const NEED_THRESHOLD = 0.05;

export function findTrades(
  myTeam: TradeFinderTeam,
  others: TradeFinderTeam[],
  leaguePosAvg: Record<TradePosition, number>,
  opts: { maxIdeas?: number } = {},
): TradeIdea[] {
  const max = opts.maxIdeas ?? 5;

  // Per-position need for the focused team. Positive = below league
  // average at this position (= upgrade target). Negative = surplus.
  const myNeed = positionNeeds(myTeam.byPos, leaguePosAvg);

  // Sell candidates on my roster. If I have nothing to sell the trade
  // finder has nothing useful to surface — return early.
  const sellTargets = myTeam.players.filter((p) => isSellSignal(p.sellWindow));
  if (sellTargets.length === 0) return [];

  const ideas: TradeIdea[] = [];

  for (const give of sellTargets) {
    for (const partner of others) {
      // Their surplus at the position I'm offering. If they're already
      // thin at that position, they have no reason to take it on.
      const surplusAvg = leaguePosAvg[give.position];
      const partnerSurplus =
        surplusAvg > 0
          ? (partner.byPos[give.position] - surplusAvg) / surplusAvg
          : 0;

      for (const receive of partner.players) {
        // Skip their own sell candidates — accepting an asset they're
        // already trying to offload is asymmetric *for* them.
        if (isSellSignal(receive.sellWindow)) continue;

        // Their player must be at a position I actually need.
        const needForReceive = myNeed[receive.position];
        if (needForReceive <= NEED_THRESHOLD) continue;

        // Don't trade away a position I'm already short at — that's
        // "trade A for B" where A and B are both my weak spots.
        if (give.position === receive.position) continue;

        // DPV proximity. Reject lopsided values on two axes:
        //   1. % imbalance — cheap-vs-cheap fairness (tight 15% gate).
        //   2. Absolute give-up — caps how much PYV the focused team
        //      can lose net even on big trades that pass the % gate.
        // Receive-more is fine (positive myDpvDelta is always allowed);
        // we only floor the give-up direction.
        const myDpvDelta = receive.dpv - give.dpv;
        if (myDpvDelta < -MAX_ABS_DPV_GIVEUP) continue;
        const dpvSpread = Math.abs(myDpvDelta);
        const dpvMax = Math.max(receive.dpv, give.dpv);
        if (dpvMax === 0) continue;
        const dpvImbalance = dpvSpread / dpvMax;
        if (dpvImbalance > MAX_DPV_IMBALANCE) continue;

        const score = scoreTrade({
          giveSell: give.sellWindow,
          receiveSignal: receive.sellWindow,
          myNeed: needForReceive,
          partnerSurplus,
          dpvImbalance,
        });

        ideas.push({
          give,
          receive,
          partnerRosterId: partner.rosterId,
          partnerName: partner.ownerName,
          partnerTeamName: partner.teamName,
          myDpvDelta,
          rationale: buildRationale({
            give,
            receive,
            myNeed: needForReceive,
            partnerSurplus,
          }),
          score,
        });
      }
    }
  }

  ideas.sort((a, b) => b.score - a.score);

  // Dedupe so the same player doesn't show up twice. Keeps the trade
  // list diverse — surfacing 5 ideas that all involve trading the same
  // RB is just one idea repeated.
  const usedGives = new Set<string>();
  const usedReceives = new Set<string>();
  const picked: TradeIdea[] = [];
  for (const idea of ideas) {
    if (picked.length >= max) break;
    if (usedGives.has(idea.give.playerId)) continue;
    if (usedReceives.has(idea.receive.playerId)) continue;
    usedGives.add(idea.give.playerId);
    usedReceives.add(idea.receive.playerId);
    picked.push(idea);
  }
  return picked;
}

// ---- helpers ---------------------------------------------------------------

function isSellSignal(sw: SellWindow | null): boolean {
  return (
    sw !== null && (sw.verdict === "SELL_NOW" || sw.verdict === "SELL_SOON")
  );
}

function positionNeeds(
  byPos: Record<TradePosition, number>,
  leaguePosAvg: Record<TradePosition, number>,
): Record<TradePosition, number> {
  const out: Record<TradePosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const p of POSITIONS) {
    const avg = leaguePosAvg[p];
    if (avg <= 0) continue;
    out[p] = (avg - byPos[p]) / avg;
  }
  return out;
}

function scoreTrade(args: {
  giveSell: SellWindow | null;
  receiveSignal: SellWindow | null;
  myNeed: number;
  partnerSurplus: number;
  dpvImbalance: number;
}): number {
  const sellUrgency =
    args.giveSell?.verdict === "SELL_NOW"
      ? 3
      : args.giveSell?.verdict === "SELL_SOON"
      ? 2
      : 0;
  const receiveDesirability =
    args.receiveSignal?.verdict === "BUY"
      ? 3
      : args.receiveSignal?.verdict === "PEAK_HOLD"
      ? 2
      : args.receiveSignal?.verdict === "HOLD"
      ? 1
      : 0;
  return (
    sellUrgency * 25 +
    receiveDesirability * 20 +
    args.myNeed * 80 +
    Math.max(args.partnerSurplus, 0) * 40 -
    args.dpvImbalance * 100
  );
}

function buildRationale(args: {
  give: TradeFinderPlayer;
  receive: TradeFinderPlayer;
  myNeed: number;
  partnerSurplus: number;
}): string {
  const giveReason =
    args.give.sellWindow?.verdict === "SELL_NOW"
      ? `${args.give.name} past peak`
      : `${args.give.name} approaching ${args.give.position} cliff`;
  const partnerReason =
    args.partnerSurplus > 0.15
      ? `they're deep at ${args.give.position}`
      : `gives them ${args.give.position} production`;
  const myReason =
    args.myNeed > 0.15
      ? `you're thin at ${args.receive.position}`
      : `${args.receive.position} depth`;
  return `Sell ${giveReason} while ${partnerReason}. Adds where ${myReason}.`;
}
