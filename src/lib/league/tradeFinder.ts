// Trade finder — surface 1-for-1 (and 1-for-2 with sweetener) trade
// ideas for a focused team.
//
// The job here is *very* specific: given a focused roster, find the
// few trades in this league that are simultaneously
//
//   1. Fair on value — blended PYV+market within ~15% of each other
//   2. Aligned with sell-window — I'm giving up someone past peak,
//      receiving someone in or before their prime
//   3. Aligned with positional need — I'm short at the position I
//      receive, the partner is deep at the position they receive
//
// Each of those alone produces noise. Combined, you get the trades
// where every party has a reason to talk. We surface 5 max — a list
// any longer reads as spam.
//
// Multi-asset (added Apr 2026): a 1-for-1 that fails on market
// disagreement (e.g. JT-for-Hurts: PYV agrees, market says JT is
// worth more) gets a second pass — try to find a small sweetener
// from the partner's roster that closes the market gap. If we can,
// surface as a 1-for-2; if we can't, drop the trade entirely.
// Picks-as-sweeteners is a follow-up — players-only for now.
//
// PYV/Market blend: fairness gates and scoring run on an *effective
// value* per player — a years-pro-weighted blend of model PYV and
// FantasyCalc market (already DPV-scaled by the caller). The
// displayed PYV delta on cards stays pure-model so "PYV +50" stays
// honest; market acts as a realism check on which trades pass.
//
// All scoring weights are intentionally small magic numbers. The goal
// is *ordering*, not calibration: as long as the ranked top-5 looks
// reasonable to a person, the absolute scores are throwaway.
//
// This is a pure function with no I/O. The caller loads rosters +
// DPVs + market values + sell-windows from the page, hands them in,
// gets trade ideas back. The page does the rendering.

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
   * established vets lean heavier on PYV.
   */
  yearsPro: number;
  /** Approximate age in years; used for richer rationale phrasing. */
  age: number | null;
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
 *  - "ok"        → market roughly agrees this is fair
 *  - "disagree"  → PYV says fair, market says lopsided. We DON'T surface
 *                  these — either we attached a sweetener that flipped
 *                  alignment to "ok", or we dropped the trade.
 *  - "none"      → at least one side has no market value; PYV-only
 */
export type MarketAlignment = "ok" | "disagree" | "none";

export type TradeIdea = {
  give: TradeFinderPlayer;
  receive: TradeFinderPlayer;
  /**
   * Additional assets the partner adds to balance market value. Empty
   * for 1-for-1 trades; one player for 1-for-2 sweetener trades.
   * (Multi-extras left open as forward-compat but the algorithm only
   * adds a single sweetener today.)
   */
  receiveExtras: TradeFinderPlayer[];
  partnerRosterId: number;
  partnerName: string;
  partnerTeamName: string | null;
  /**
   * Total focused-team PYV gain across all assets exchanged. Pure
   * PYV — keeps the "PYV +X" label honest even when filtering used
   * the blend.
   */
  myDpvDelta: number;
  /** How market view compares to PYV view for this trade after sweetener. */
  marketAlignment: MarketAlignment;
  /** 1-2 sentence explanation, contextual to this specific trade. */
  rationale: string;
  /** Internal score; not user-facing — used for ranking. */
  score: number;
};

const POSITIONS: TradePosition[] = ["QB", "RB", "WR", "TE"];

// Ignore trades where blended-value gap exceeds this fraction of the
// larger side. 15% keeps the win-now-premium use case (vet for younger
// asset) without surfacing trades a manager would laugh at.
const MAX_VALUE_IMBALANCE = 0.15;

// Hard floor on what the focused team can give up net (in blended
// value). Even if a trade passes the % gate, suggesting "give up 749
// blended value more than you get back" is bad UX. 250 is roughly
// "one tier" of value.
const MAX_ABS_VALUE_GIVEUP = 250;

// Position need threshold below which we don't count a position as a
// "real" need. Stops a roster that's 1% below average from being
// flagged as needing the position.
const NEED_THRESHOLD = 0.05;

// When picking a sweetener from the partner's roster, skip players at
// positions where the partner is critically thin — they won't part
// with a starter at a need position.
const PARTNER_SWEETENER_NEED_BLOCK = 0.10;

// Years-pro → market weight in the PYV/market blend. Rookies lean
// heaviest on market because PYV is essentially a prior with no
// evidence yet; vets lean a bit toward PYV because we have multi-
// season production data — but market still gets ~40% even on vets
// because that's what stops "JT for Baker Mayfield" trades.
function marketBlendWeight(yearsPro: number): number {
  if (yearsPro <= 0) return 0.6;
  if (yearsPro === 1) return 0.5;
  if (yearsPro === 2) return 0.45;
  return 0.4;
}

// Trade-level alignment tolerance. Deltas within this fraction of the
// larger side are "small enough" that direction disagreement is noise.
const MARKET_DISAGREE_FRACTION = 0.12;

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

function sumEff(players: TradeFinderPlayer[]): number {
  return players.reduce((acc, p) => acc + effectiveValue(p), 0);
}
function sumPyv(players: TradeFinderPlayer[]): number {
  return players.reduce((acc, p) => acc + p.dpv, 0);
}
function sumMarket(players: TradeFinderPlayer[]): number | null {
  let sum = 0;
  for (const p of players) {
    if (p.marketValue === null) return null;
    sum += p.marketValue;
  }
  return sum;
}

/**
 * Classify how the FantasyCalc market view compares to the PYV view
 * for this trade given current give/receive bundles.
 *
 *   - "none"     when any side is missing a market value
 *   - "ok"       when signs agree, or both deltas are within tol
 *   - "disagree" when signs differ AND at least one delta is material
 */
function classifyAlignment(
  giveSide: TradeFinderPlayer[],
  receiveSide: TradeFinderPlayer[],
): MarketAlignment {
  const givePyv = sumPyv(giveSide);
  const receivePyv = sumPyv(receiveSide);
  const giveMkt = sumMarket(giveSide);
  const receiveMkt = sumMarket(receiveSide);
  if (giveMkt === null || receiveMkt === null) return "none";
  const pyvDelta = receivePyv - givePyv;
  const mktDelta = receiveMkt - giveMkt;
  const scale = Math.max(givePyv, receivePyv, 1);
  const tol = scale * MARKET_DISAGREE_FRACTION;
  // Same sign → both views agree on direction → ok
  if (pyvDelta * mktDelta >= 0) return "ok";
  // Opposite signs but both small → noise → ok
  if (Math.abs(pyvDelta) <= tol && Math.abs(mktDelta) <= tol) return "ok";
  return "disagree";
}

/**
 * Try to pick a single sweetener from the partner's roster that
 * brings a "disagree" trade to "ok". Returns the best candidate or
 * null if no sweetener works.
 *
 * Strategy: the focused team is winning on PYV but losing on market —
 * the gap to close is `give.market - receive.market`. Pick the
 * partner-side asset whose market value is closest to that gap (and
 * which doesn't break the blend gate or strip a position the partner
 * is thin at).
 */
function findSweetener(args: {
  give: TradeFinderPlayer;
  receive: TradeFinderPlayer;
  partnerPlayers: TradeFinderPlayer[];
  partnerByPos: Record<TradePosition, number>;
  leaguePosAvg: Record<TradePosition, number>;
  excludeIds: Set<string>;
}): TradeFinderPlayer | null {
  const { give, receive, partnerPlayers, partnerByPos, leaguePosAvg, excludeIds } = args;
  if (give.marketValue === null || receive.marketValue === null) return null;
  const targetGap = give.marketValue - receive.marketValue;
  // Only handles the "focused team gains PYV, loses market" direction.
  // The opposite direction (PYV loss, market gain) isn't a trade we'd
  // surface anyway — focused team has no PYV reason to make it.
  if (targetGap <= 0) return null;

  const giveEff = effectiveValue(give);
  let best: { player: TradeFinderPlayer; distance: number } | null = null;

  for (const c of partnerPlayers) {
    if (excludeIds.has(c.playerId)) continue;
    if (c.playerId === receive.playerId) continue;
    if (c.marketValue === null || c.marketValue <= 0) continue;
    if (c.dpv <= 0) continue;

    // Don't take a player from partner's thin positions — they won't
    // part with a starter where they have a hole.
    const avg = leaguePosAvg[c.position];
    const partnerNeed = avg > 0 ? (avg - partnerByPos[c.position]) / avg : 0;
    if (partnerNeed > PARTNER_SWEETENER_NEED_BLOCK) continue;

    // Re-check fairness with the bundled receive side.
    const newReceiveEff = effectiveValue(receive) + effectiveValue(c);
    const effDelta = newReceiveEff - giveEff;
    if (effDelta < -MAX_ABS_VALUE_GIVEUP) continue;
    const effMax = Math.max(newReceiveEff, giveEff);
    if (effMax === 0) continue;
    if (Math.abs(effDelta) / effMax > MAX_VALUE_IMBALANCE) continue;

    // Re-classify alignment after sweetener — must reach "ok" or we
    // gained nothing by adding it.
    const newAlign = classifyAlignment([give], [receive, c]);
    if (newAlign !== "ok") continue;

    // Score by how close the sweetener brings market delta to zero.
    // Closer = fairer on market = better choice.
    const newMarketDelta =
      (receive.marketValue + c.marketValue) - give.marketValue;
    const distance = Math.abs(newMarketDelta);
    if (best === null || distance < best.distance) {
      best = { player: c, distance };
    }
  }

  return best?.player ?? null;
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

      for (const receiveAnchor of partner.players) {
        // Skip their own sell candidates — accepting an asset they're
        // already trying to offload is asymmetric *for* them.
        if (isSellSignal(receiveAnchor.sellWindow)) continue;

        // Their player must be at a position I actually need.
        const needForReceive = myNeed[receiveAnchor.position];
        if (needForReceive <= NEED_THRESHOLD) continue;

        // Don't trade away a position I'm already short at — that's
        // "trade A for B" where A and B are both my weak spots.
        if (give.position === receiveAnchor.position) continue;

        // 1-for-1 fairness gate (blended values).
        const receiveEff = effectiveValue(receiveAnchor);
        const effDelta = receiveEff - giveEff;
        if (effDelta < -MAX_ABS_VALUE_GIVEUP) continue;
        const effMax = Math.max(receiveEff, giveEff);
        if (effMax === 0) continue;
        if (Math.abs(effDelta) / effMax > MAX_VALUE_IMBALANCE) continue;

        let receiveExtras: TradeFinderPlayer[] = [];
        let alignment = classifyAlignment([give], [receiveAnchor]);

        // Market disagrees on the 1-for-1? Try to find a sweetener
        // from the partner's roster. If we can't, drop the trade —
        // surfacing "PYV says yes, market says no" trades just wastes
        // the user's attention.
        if (alignment === "disagree") {
          const sweetener = findSweetener({
            give,
            receive: receiveAnchor,
            partnerPlayers: partner.players,
            partnerByPos: partner.byPos,
            leaguePosAvg,
            excludeIds: new Set([give.playerId, receiveAnchor.playerId]),
          });
          if (sweetener === null) continue;
          receiveExtras = [sweetener];
          alignment = "ok";
        }

        // Pure-PYV total delta — what the card displays.
        const myDpvDelta =
          receiveAnchor.dpv +
          receiveExtras.reduce((a, p) => a + p.dpv, 0) -
          give.dpv;

        // Recompute the blend imbalance over the final bundle for
        // scoring; the gate above only checked the 1-for-1 leg.
        const finalReceiveEff =
          receiveEff + receiveExtras.reduce((a, p) => a + effectiveValue(p), 0);
        const finalImbalance =
          Math.abs(finalReceiveEff - giveEff) /
          Math.max(finalReceiveEff, giveEff, 1);

        const score = scoreTrade({
          giveSell: give.sellWindow,
          receiveSignal: receiveAnchor.sellWindow,
          myNeed: needForReceive,
          partnerSurplus,
          effImbalance: finalImbalance,
          marketAlignment: alignment,
          isMultiAsset: receiveExtras.length > 0,
        });

        ideas.push({
          give,
          receive: receiveAnchor,
          receiveExtras,
          partnerRosterId: partner.rosterId,
          partnerName: partner.ownerName,
          partnerTeamName: partner.teamName,
          myDpvDelta,
          marketAlignment: alignment,
          rationale: buildRationale({
            give,
            receive: receiveAnchor,
            receiveExtras,
            myNeed: needForReceive,
            partnerSurplus,
            partnerName: partner.ownerName,
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
    const allReceives = [idea.receive, ...idea.receiveExtras];
    if (allReceives.some((p) => usedReceives.has(p.playerId))) continue;
    usedGives.add(idea.give.playerId);
    for (const p of allReceives) usedReceives.add(p.playerId);
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
  isMultiAsset: boolean;
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
  // Slight bias toward market-aligned trades; PYV-only is neutral.
  const alignmentBonus = args.marketAlignment === "ok" ? 5 : 0;
  // Multi-asset trades are harder to negotiate (more pieces, more
  // approval needed) — slight ranking penalty so 1-for-1s with similar
  // structural fit win the tie-break.
  const multiPenalty = args.isMultiAsset ? -8 : 0;
  return (
    sellUrgency * 25 +
    receiveDesirability * 20 +
    args.myNeed * 80 +
    Math.max(args.partnerSurplus, 0) * 40 -
    args.effImbalance * 100 +
    alignmentBonus +
    multiPenalty
  );
}

// ---- Rationale generation --------------------------------------------------

// The old rationale was a single template ("Sell X approaching Y cliff
// while ..."). Every card read identical, so users learned to ignore
// the line. The new generator picks one phrase per role (give / receive
// / partner) from a context-aware pool and stitches 1-2 short sentences.
// The goal is for two cards on screen to read distinctly different.

function buildRationale(args: {
  give: TradeFinderPlayer;
  receive: TradeFinderPlayer;
  receiveExtras: TradeFinderPlayer[];
  myNeed: number;
  partnerSurplus: number;
  partnerName: string;
}): string {
  const giveLine = giveReason(args.give);
  const receiveLine = receiveReason(args.receive, args.myNeed);
  const partnerLine = partnerReason(
    args.give,
    args.partnerSurplus,
    args.partnerName,
  );
  const sweetenerLine = sweetenerNote(args.receiveExtras);

  // Build 1-2 sentences. Lead with the strongest "why" — usually the
  // give-side urgency, since the trade finder only fires on sells.
  let s = `${capitalize(giveLine)}; ${receiveLine}.`;
  if (partnerLine) s += ` ${partnerLine}.`;
  if (sweetenerLine) s += ` ${sweetenerLine}.`;
  return s;
}

function giveReason(give: TradeFinderPlayer): string {
  const sw = give.sellWindow;
  const ageStr = give.age !== null ? ` (${Math.floor(give.age)})` : "";
  if (sw?.verdict === "SELL_NOW") {
    if (give.position === "RB" && give.age !== null && give.age >= 28) {
      return `${give.name}${ageStr} is past the RB cliff — this is the last window`;
    }
    if (give.position === "WR" && give.age !== null && give.age >= 30) {
      return `${give.name}${ageStr} is on the back nine — sell while name still moves`;
    }
    if (give.position === "TE" && give.age !== null && give.age >= 30) {
      return `${give.name}${ageStr} is past the TE prime — value won't get higher`;
    }
    return `${give.name}'s value tops out now — every week from here is a discount`;
  }
  if (sw?.verdict === "SELL_SOON") {
    if (give.position === "RB") {
      return `${give.name}${ageStr} is one season from the RB cliff`;
    }
    if (give.position === "WR") {
      return `${give.name}${ageStr} approaches the WR decline next year`;
    }
    return `${give.name}${ageStr} is at the edge of his ${give.position} prime`;
  }
  return `Move ${give.name} while the market still pays full price`;
}

function receiveReason(
  receive: TradeFinderPlayer,
  myNeed: number,
): string {
  const ageStr = receive.age !== null ? ` (${Math.floor(receive.age)})` : "";
  const sw = receive.sellWindow;
  // Strong positional need wins over softer fits — quantify it.
  if (myNeed > 0.25) {
    return `you're ${Math.round(myNeed * 100)}% below average at ${receive.position}, and ${receive.name}${ageStr} fixes that`;
  }
  if (sw?.verdict === "BUY") {
    return `${receive.name}${ageStr} is rising — buy before market catches up`;
  }
  if (sw?.verdict === "PEAK_HOLD") {
    return `${receive.name}${ageStr} is in his prime — locked-in production`;
  }
  if (myNeed > NEED_THRESHOLD) {
    return `${receive.name}${ageStr} adds depth at ${receive.position} where you're light`;
  }
  return `add ${receive.name}${ageStr} at ${receive.position}`;
}

function partnerReason(
  give: TradeFinderPlayer,
  partnerSurplus: number,
  partnerName: string,
): string | null {
  if (partnerSurplus > 0.25) {
    return `${partnerName} is ${Math.round(partnerSurplus * 100)}% deep at ${give.position} — they can absorb the hit`;
  }
  if (partnerSurplus > 0.10) {
    return `${partnerName} runs surplus at ${give.position}`;
  }
  if (give.sellWindow?.verdict === "SELL_NOW") {
    return `${partnerName} probably hasn't priced the cliff in yet`;
  }
  return null;
}

function sweetenerNote(extras: TradeFinderPlayer[]): string | null {
  if (extras.length === 0) return null;
  const names = extras.map((e) => e.name).join(" + ");
  return `Ask for ${names} on top so the market values balance`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s[0].toUpperCase() + s.slice(1);
}
