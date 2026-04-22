// Dynasty rookie pick valuation.
//
// Three inputs compose a pick's DPV:
//   1. Baseline curve  — % of the 1.01 value, by pick slot.
//   2. Year distance   — discount for picks further out (class uncertainty).
//   3. Class strength  — optional per-year multiplier. Defaults to 1.0 until
//      Phase 3 (prospect ingestion) populates consensus grades.
//
// Window: we carry the next 3 rookie-draft years. Once the NFL season for the
// earliest year kicks off (late August), that class's rookies stop being
// "picks" and move into the rookie prior model (Phase 2); the window rolls
// forward to pick up the new +3 year.

// Base value assigned to the 1.01 of the current rookie draft class,
// pre-discount. Scaled so a consensus-strong 1.01 approximates a low-end
// dynasty WR1 (the typical market price). Tune this one number to rescale
// all picks uniformly.
export const BASELINE_1_01_DPV = 6000;

// Curve: fraction of 1.01 value at each pick slot. Based on typical dynasty
// market (KTC / DLF) shape — steep in the first round, flattens through R3.
// Indexed as `${round}.${String(slot).padStart(2, "0")}`.
export const PICK_CURVE: Record<string, number> = {
  // Round 1
  "1.01": 1.0,
  "1.02": 0.85,
  "1.03": 0.75,
  "1.04": 0.68,
  "1.05": 0.58,
  "1.06": 0.5,
  "1.07": 0.44,
  "1.08": 0.4,
  "1.09": 0.36,
  "1.10": 0.33,
  "1.11": 0.31,
  "1.12": 0.29,
  // Round 2
  "2.01": 0.25,
  "2.02": 0.22,
  "2.03": 0.2,
  "2.04": 0.18,
  "2.05": 0.16,
  "2.06": 0.14,
  "2.07": 0.13,
  "2.08": 0.11,
  "2.09": 0.1,
  "2.10": 0.09,
  "2.11": 0.08,
  "2.12": 0.07,
  // Round 3
  "3.01": 0.06,
  "3.02": 0.055,
  "3.03": 0.05,
  "3.04": 0.045,
  "3.05": 0.04,
  "3.06": 0.035,
  "3.07": 0.03,
  "3.08": 0.028,
  "3.09": 0.025,
  "3.10": 0.022,
  "3.11": 0.02,
  "3.12": 0.018,
};

// Year-distance discount. Same-year picks (the class about to be drafted)
// are worth full baseline; each additional year out applies a multiplier.
export const YEAR_DISTANCE_MULTIPLIER: Record<0 | 1 | 2, number> = {
  0: 1.0,
  1: 0.75,
  2: 0.55,
};

// Per-year class strength multiplier. 1.0 = average class. These values are
// placeholder defaults and will be overwritten by the Phase 3 prospect
// aggregation once that data exists. Updated by hand in the meantime.
export const CLASS_STRENGTH: Record<number, number> = {
  // e.g. 2027: 1.08  (consensus currently views it as a strong class)
};

// Determine which three rookie-draft years are currently tradeable.
// Rookie drafts happen in April-May after the NFL combine. Once the season
// for year N starts (Sept 1), year N's picks stop being "picks" — the players
// selected are tracked via the rookie prior model instead.
//
// We pivot on Sept 1 of each year: before Sept 1, the window is
// [thisYear, +1, +2]; on/after Sept 1, the window shifts to [+1, +2, +3].
export function currentPickWindow(now: Date = new Date()): [number, number, number] {
  const year = now.getUTCFullYear();
  const pivot = new Date(Date.UTC(year, 8, 1)); // Sept 1 UTC
  const base = now >= pivot ? year + 1 : year;
  return [base, base + 1, base + 2];
}

// Compute the raw DPV for a given pick in a given year.
// `classOverrides` lets callers inject dynamic per-year multipliers from the
// Phase 3 class_strength table, falling back to the static CLASS_STRENGTH
// map and finally to 1.0 (neutral class).
export function pickDpv(
  year: number,
  round: 1 | 2 | 3,
  slot: number,
  windowBase: number,
  classOverrides?: Record<number, number>,
): number {
  const key = `${round}.${String(slot).padStart(2, "0")}`;
  const curve = PICK_CURVE[key];
  if (curve === undefined) return 0;
  const distance = Math.max(0, year - windowBase);
  if (distance > 2) return 0;
  const distMult =
    YEAR_DISTANCE_MULTIPLIER[distance as 0 | 1 | 2] ?? 0;
  const classMult =
    classOverrides?.[year] ?? CLASS_STRENGTH[year] ?? 1.0;
  return Math.round(BASELINE_1_01_DPV * curve * distMult * classMult);
}
