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
//
// PYV/Market blend (added Apr 2026): fairness gates and scoring run on
// an *effective value* per player — a years-pro-weighted blend of the
// model's PYV and the FantasyCalc market value (already scaled to the
// DPV magnitude by the caller). The displayed PYV delta on cards stays
// pure-model so the label "PYV +50" stays honest; market only acts as
// a realism check on which trades pass through. A `marketAlignment`
// tag surfaces whether market backs or rejects the PYV view so the
// user understands why a trade is being suggested.

import type { SellWindow } from "@/lib/dpv/sellWindow";

export type TradePosition = "QB" | "RB" | "WR" | "TE";

export type TradeFinderPlayer = {
  playerId: string;
  name: string;
  position: TradePosition;
  dpv: number;
  /**
   * FantasyCalc market value, already scaled by the caller to the DPV
   * magnitude (so it can be averaged with `dpv` directly). Null if the
   * player isn't in the FantasyCalc feed — we then fall back to pure
   * PYV for fairness/scoring on this player.
   */
  marketValue: number | null;
  /**
   * Approximate NFL years played. Drives the PYV/market blend weight:
   * rookies lean heavier on market (PYV is essentially a prior),
   * established vets lean heavier on PYV (we have multi-year evidence).
   */
  yearsPro: number;
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

/**
 * How market alignment compares to PYV alignment for the trade overall.
 *  - "ok"        → market roughly agrees this is fair (delta within tol)
 *  - "disagree"  → PYV says fair, market says lopsided (still surfaced
 *                  if the blended gate passed, but flagged so the user
 *                  knows the market sees this differently)
 *  - "none"      → at least one player has no market value; PYV-only
 */
export type MarketAlignment = "ok" | "disagree" | "none";

export type TradeIdea = {
  give: TradeFinderPlayer;
  receive: TradeFinderPlayer;
  partnerRosterId: number;
  partnerName: string;
  partnerTeamName: string | null;
  /** receive.dpv − give.dpv; positive = focused team gains DPV. */
  myDpvDelta: number;
  /** How market view compares to PYV view for this 1-for-1. */
  marketAlignment: MarketAlignment;
  /** 1-sentence explanation suitable for the card subtitle. */
  rationale: string;
  /** Internal score; not user-facing — used for ranking. */
  score: number;
};

const POSITIONS: TradePosition[] = ["QB", "RB", "WR", "TE"];

// Ignore trades where blended-value gap exceeds this fraction of the
// larger player. Tightened from 0.30 to 0.15 — the old gate let through
// trades like "give Justin Jefferson, receive Daniel Jones" because the
// % gap was technically under 30%. 15% keeps the win-now-premium use
// case (vet for younger asset) without surfacing trades a manager would
// laugh at. The blend means a high-PYV / low-market player can still
// fail this gate when market disagrees with the model.
const MAX_VALUE_IMBALANCE = 0.15;

// Hard floor on what the focused team can give up net (in blended
// value). Even if a trade passes the % gate, suggesting "give up 749
// blended value more than you get back" is bad UX — the percentage
// gate alone is too permissive when both players are 4000+ value.
// 250 is roughly "one tier" of value, which is the most we'll let a
// sell-window trade swing.
const MAX_ABS_VALUE_GIVEUP = 250;

// Position need threshold below which we don't count a position as a
// "real" need. Stops a roster that's 1% below average from being
// flagged as needing the position.
const NEED_THRESHOLD = 0.05;

// Years-pro → market weight in the PYV/market blend. Rookies lean
// heaviest on market because PYV is essentially a prior with no
// evidence yet; vets lean a bit toward PYV because we have multi-
// season production data — but market still gets ~40% even on vets
// because that's what stops "JT for Baker Mayfield" trades: their
// PYVs are similar but their FantasyCalc markets differ ~3×, and
// without serious market weight the blend can't filter that.
//
// The weights below mean a vet with PYV 5000 / market 1800 ends up
// at effective value ~3720 (60% × 5000 + 40% × 1800), which is far
// enough below a true-5000-value player that the 15% imbalance gate
// rejects the trade outright — no need for a separate "Market
// disagrees" signal that surfaces bad trades anyway.
function marketBlendWeight(yearsPro: number): number {
  if (yearsPro <= 0) return 0.6;
  if (yearsPro === 1) return 0.5;
  if (yearsPro === 2) return 0.45;
  return 0.4;
}

// Trade-level alignment tolerance. If pure-PYV delta and pure-market
// delta land within this fraction of the larger player's PYV, we call
// it "ok"; otherwise market and PYV disagree and we flag it.
const MARKET_DISAGREE_FRACTION = 0.15;

/**
 * Combine a player's PYV and (DPV-scaled) market value into a single
 * effective value for fairness and scoring. Falls back to pure PYV
 * when no market value is available.
 */
function effectiveValue(player: TradeFinderPlayer): number {
  if (player.marketValue === null) return player.dpv;
  const w = marketBlendWeight(player.yearsPro);
  return player.dpv * (1 - w) + player.marketValue * w;
}

/**
 * Classify how the FantasyCalc market view compares to the PYV view
 * for this specific 1-for-1. We compare the sign + magnitude of the
 * pure-PYV delta against the sign + magnitude of the pure-market delta:
 *
 *   - both null/missing → "none" (PYV-only fairness)
 *   - same sign and within tolerance → "ok" (market backs PYV)
 *   - opposite sign or outside tolerance → "disagree" (flag it)
 */
function classifyAlignment(
  give: TradeFinderPlayer,
  receive: TradeFinderPlayer,
): MarketAlignment {
  if (give.marketValue === null || receive.marketValue === null) return "none";
  const pyvDelta = receive.dpv - give.dpv;
  const mktDelta = receive.marketValue - give.marketValue;
  const scale = Math.max(give.dpv, receive.dpv, 1);
  // If the deltas point in opposite directions and either is non-trivial,
  // they disagree. ("Non-trivial" = bigger than the disagree fraction;
  // tiny deltas in opposite directions are noise.)
  const tol = scale * MARKET_DISAGREE_FRACTION;
  if (pyvDelta * mktDelta < 0) {
    if (Math.abs(pyvDelta) > tol || Math.abs(mktDelta) > tol) return "disagree";
  }
  // Same sign — also disagree if magnitudes diverge by more than tol.
  if (Math.abs(pyvDelta - mktDelta) > tol) return "disagree";
  return "ok";
}

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
    const giveEff = effectiveValue(give);
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

        // Blended-value proximity. We compute *effective* value per
        // player (PYV + scaled market, year-aware) and gate fairness
        // on that. This is what stops "JT for Jared Goff": JT's PYV
        // is high but his market is also high; Goff's PYV may be high
        // but his market is much lower — the blended values diverge
        // and the trade fails the gate even when pure-PYV would pass.
        // Reject lopsided values on two axes:
        //   1. % imbalance — cheap-vs-cheap fairness (tight 15% gate).
        //   2. Absolute give-up — caps how much value the focused team
        //      can lose net even on big trades that pass the % gate.
        // Receive-more is fine (positive delta is always allowed);
        // we only floor the give-up direction.
        const receiveEff = effectiveValue(receive);
        const effDelta = receiveEff - giveEff;
        if (effDelta < -MAX_ABS_VALUE_GIVEUP) continue;
        const effSpread = Math.abs(effDelta);
        const effMax = Math.max(receiveEff, giveEff);
        if (effMax === 0) continue;
        const effImbalance = effSpread / effMax;
        if (effImbalance > MAX_VALUE_IMBALANCE) continue;

        // Pure-PYV delta is what we display on the card — keeps the
        // "PYV +X" label honest even though we filtered with the blend.
        const myDpvDelta = receive.dpv - give.dpv;
        const marketAlignment = classifyAlignment(give, receive);

        const score = scoreTrade({
          giveSell: give.sellWindow,
          receiveSignal: receive.sellWindow,
          myNeed: needForReceive,
          partnerSurplus,
          effImbalance,
          marketAlignment,
        });

        ideas.push({
          give,
          receive,
          partnerRosterId: partner.rosterId,
          partnerName: partner.ownerName,
          partnerTeamName: partner.teamName,
          myDpvDelta,
          marketAlignment,
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
  effImbalance: number;
  marketAlignment: MarketAlignment;
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
  // Slight bias toward market-aligned trades: a trade where market
  // backs the PYV view is more likely to actually get accepted by the
  // counterparty. Disagree trades still surface (the gate already
  // filtered the egregious ones) but rank below ok'd peers.
  const alignmentBonus =
    args.marketAlignment === "ok"
      ? 10
      : args.marketAlignment === "none"
      ? 0
      : -8;
  return (
    sellUrgency * 25 +
    receiveDesirability * 20 +
    args.myNeed * 80 +
    Math.max(args.partnerSurplus, 0) * 40 -
    args.effImbalance * 100 +
    alignmentBonus
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
