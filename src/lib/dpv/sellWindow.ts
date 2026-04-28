// Sell-window indicator — per-player verdict on when to trade.
//
// The decision a fantasy manager actually has every week is:
// "Should I trade this player now, or hold?" Three signals matter:
//
//   1. AGE vs. position cliff. RBs cliff at 27, WRs at 30, TEs at 31,
//      QBs at 35. Once past the cliff, value falls fast.
//   2. MARKET DELTA. The gap between our DPV rank and the market's
//      (FantasyCalc) rank. Positive = market underrates ("Buy"),
//      negative = market overrates ("Sell").
//   3. TIMING. The fantasy trade market is most liquid in the offseason
//      — that's when "sell within X weeks" becomes "sell THIS offseason"
//      or "sell NEXT offseason."
//
// We collapse those three into a single verdict with five buckets:
//
//   - SELL NOW   (bad)     — past peak AND market still rates them high
//                            (or simply old enough that there's no later)
//   - SELL SOON  (warn)    — entering decline; sell this/next offseason
//   - HOLD       (neutral) — mid-prime, no strong urgency
//   - PEAK HOLD  (good)    — at peak, ride them; trade value is right
//   - BUY        (elite)   — young AND market underrates them
//
// The verdict is intentionally opinionated — "no signal" players just
// fall through to HOLD with a generic reason. A blank tag would be more
// honest but less useful; HOLD-by-default keeps every roster row
// scannable.

import { AGE_CLIFFS } from "./constants-aging";

export type Position = "QB" | "RB" | "WR" | "TE";

export type SellVerdict = "SELL_NOW" | "SELL_SOON" | "HOLD" | "PEAK_HOLD" | "BUY";

export type SellWindowTone = "bad" | "warn" | "neutral" | "good" | "elite";

export type SellWindow = {
  verdict: SellVerdict;
  /** Two-word UI label, e.g. "Sell now", "Peak hold". */
  label: string;
  tone: SellWindowTone;
  /** Short rationale; 1 sentence, suitable for a tooltip or row. */
  reason: string;
  /** Suggested action timing: now / this off-season / next off-season / open. */
  timing: "now" | "this-offseason" | "next-offseason" | "open";
};

export type SellWindowInput = {
  position: Position;
  age: number | null;
  /** Current DPV. Used only for the "completely off the radar" floor. */
  dpv: number;
  /**
   * Per-position rank difference: ourRank - marketRank.
   * Positive = market underrates (Buy signal). Negative = market overrates
   * (Sell signal). Null when no market data is available — the verdict
   * gracefully falls back to age-only signal.
   */
  marketDelta: number | null;
};

// ---- Tunable thresholds ----------------------------------------------------
//
// MARKET_BUY_GAP / MARKET_SELL_GAP are in *rank positions* within the
// position group. A 5-rank gap at WR is meaningful (top-30 vs top-25).
// At TE it's larger because the position is shallow.
const MARKET_BUY_GAP = 5;
const MARKET_SELL_GAP = -5;

// Floor: a player buried below replacement at every position can't
// generate any verdict besides "Hold (deep bench)" — they're not even
// on the trade market.
const DEEP_BENCH_DPV = 200;

// Approximate NFL years played from age + position. QBs typically
// enter at 23, skill players at 22 — that offset is the only
// positional split. Used to gate the "fade the market" sell-fallback
// on players with too little NFL evidence for the model to be right.
function approxYearsPro(position: Position, age: number): number {
  const baseAge = position === "QB" ? 23 : 22;
  return Math.max(0, Math.floor(age - baseAge));
}

export function computeSellWindow(input: SellWindowInput): SellWindow {
  const { position, age, dpv, marketDelta } = input;

  // No age = unknown asset. We can still emit a market-driven signal
  // if marketDelta is strong, otherwise fall through to HOLD.
  if (age === null || !Number.isFinite(age)) {
    if (marketDelta !== null && marketDelta >= MARKET_BUY_GAP) {
      return verdict("BUY", "Market values them below our DPV — buy candidate.", "open");
    }
    if (marketDelta !== null && marketDelta <= MARKET_SELL_GAP) {
      return verdict("SELL_SOON", "Market values them above our DPV — sell candidate.", "this-offseason");
    }
    return verdict("HOLD", "No urgent signal.", "open");
  }

  if (dpv < DEEP_BENCH_DPV) {
    return verdict("HOLD", "Deep bench — not really on the trade market.", "open");
  }

  const cliff = AGE_CLIFFS[position];
  const yearsToCliff = cliff.full - age; // negative = already past peak
  const yearsPro = approxYearsPro(position, age);

  // ---- SELL NOW --------------------------------------------------------
  // Past the position's full-value zone AND market hasn't fully discounted.
  // This is the "their value will never be higher than today" tag.
  if (age >= cliff.cliff) {
    return verdict(
      "SELL_NOW",
      `Past the ${position} cliff (${cliff.cliff}) — value won't get higher than now.`,
      "now",
    );
  }

  if (yearsToCliff <= 0 && marketDelta !== null && marketDelta <= MARKET_SELL_GAP) {
    return verdict(
      "SELL_NOW",
      `Past ${position} peak and market still overrates them — sell while they do.`,
      "now",
    );
  }

  // ---- SELL SOON -------------------------------------------------------
  // Within ~1 year of peak — the next offseason is your last chance to
  // sell at full price. Tightened with a sell-side market signal.
  if (yearsToCliff <= 1) {
    const market = marketDelta !== null && marketDelta <= MARKET_SELL_GAP
      ? " Market still rates them high — capitalize before the gap closes."
      : "";
    return verdict(
      "SELL_SOON",
      `Approaching ${position} peak (${cliff.full}) — sell this off-season.${market}`,
      "this-offseason",
    );
  }

  // ---- BUY -------------------------------------------------------------
  // Young AND market underrates them — the asymmetric upside trade.
  // Age threshold is "well under cliff.full" so 24yo WRs (already
  // expensive) don't trigger BUY tags constantly.
  if (
    yearsToCliff >= 4 &&
    marketDelta !== null &&
    marketDelta >= MARKET_BUY_GAP
  ) {
    return verdict(
      "BUY",
      `Young (${age.toFixed(0)}) and market underrates — accumulate.`,
      "open",
    );
  }

  // ---- PEAK HOLD -------------------------------------------------------
  // Inside the prime window. Ride them; the trade value matches the
  // production. No urgency — just don't sell at a discount.
  if (yearsToCliff <= 3) {
    return verdict(
      "PEAK_HOLD",
      `Peak window — value matches production. Hold for points.`,
      "open",
    );
  }

  // ---- YOUNG-PLAYER GUARD ----------------------------------------------
  // Rookies and second-year players have very thin NFL evidence. Our
  // PYV stays conservative on them while FantasyCalc loves the rookie
  // hype, so marketDelta is naturally very negative. Don't tag them
  // SELL_SOON for that — let the evidence accumulate.
  if (yearsPro <= 2) {
    if (marketDelta !== null && marketDelta >= MARKET_BUY_GAP) {
      // Rare, but if our model already loves them more than the market,
      // the BUY signal is honest.
      return verdict(
        "BUY",
        `Young (${age.toFixed(0)}) — model rates them ahead of market.`,
        "open",
      );
    }
    if (marketDelta !== null && marketDelta <= MARKET_SELL_GAP) {
      return verdict(
        "HOLD",
        `Young (${age.toFixed(0)}) — market sees more than our model yet; let evidence accumulate before selling.`,
        "open",
      );
    }
    return verdict(
      "HOLD",
      `Young (${age.toFixed(0)}) — model still calibrating, default hold.`,
      "open",
    );
  }

  // ---- HOLD (default) --------------------------------------------------
  // Everyone else: too far from cliff for sell timing, no market gap
  // for buy timing. Generic hold.
  if (marketDelta !== null && marketDelta <= MARKET_SELL_GAP) {
    return verdict(
      "SELL_SOON",
      `Market overrates relative to our DPV — sell candidate.`,
      "next-offseason",
    );
  }
  if (marketDelta !== null && marketDelta >= MARKET_BUY_GAP) {
    return verdict(
      "BUY",
      `Market underrates relative to our DPV — buy candidate.`,
      "open",
    );
  }
  return verdict("HOLD", "No urgent signal — fairly priced.", "open");
}

// ---- Verdict construction --------------------------------------------------

function verdict(
  v: SellVerdict,
  reason: string,
  timing: SellWindow["timing"],
): SellWindow {
  return {
    verdict: v,
    label: LABELS[v],
    tone: TONES[v],
    reason,
    timing,
  };
}

const LABELS: Record<SellVerdict, string> = {
  SELL_NOW: "Sell now",
  SELL_SOON: "Sell soon",
  HOLD: "Hold",
  PEAK_HOLD: "Peak hold",
  BUY: "Buy",
};

const TONES: Record<SellVerdict, SellWindowTone> = {
  SELL_NOW: "bad",
  SELL_SOON: "warn",
  HOLD: "neutral",
  PEAK_HOLD: "good",
  BUY: "elite",
};
