// Dynasty rookie pick valuation.
//
// Three inputs compose a pick's DPV:
//   1. Baseline curve  — % of the 1.01 value, by pick slot.
//   2. Year distance   — discount for picks further out (class uncertainty).
//   3. Class strength  — slot-aware multiplier derived from projected NFL
//      draft depth (Phase 3). Defaults to 1.0 until prospect data exists.
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

// Cross-year depth anchors. "Typical" modern offensive draft depth — used as
// the neutral reference point the per-year class signal compares against.
// BASELINE_R1: offensive players (QB/RB/WR/TE) projected in NFL Round 1.
// BASELINE_TOP15: offensive players projected in the top 15 overall picks.
export const BASELINE_R1_OFFENSE_COUNT = 7;
export const BASELINE_TOP15_OFFENSE_COUNT = 3;

// Tunables for the slot-aware multiplier. Change with care — small shifts
// ripple through the whole pick market.
const DEPTH_DECAY_PER_SLOT = 0.04;   // value lost per slot past R1 cliff
const DEPTH_FLOOR = 0.5;             // a pick can't shrink below half baseline
const DEPTH_CEIL = 1.0;              // depth alone never boosts over baseline
const ELITE_BOOST_PER_COUNT = 0.04;  // per extra top-15 prospect vs baseline
const ELITE_TOTAL_CAP = 1.15;        // ceiling after elite head boost

// Raw per-year class signal, sourced from public.class_strength. Nullable
// counts mean "no data yet" and force a neutral 1.0 multiplier.
export type ClassStrengthInput = {
  r1_offensive_count: number | null;
  top15_offensive_count: number | null;
};

// Slot-aware class multiplier. Picks up to the class's projected R1 offensive
// depth hold baseline value; past that cliff, each slot decays linearly. The
// top ~5 picks additionally scale with unusual top-15 depth — a class with
// multiple expected elite prospects lifts its 1.01-1.05.
//
// slotRank is 1..36 across rounds 1-3 (1.01 = 1, 2.01 = 13, 3.01 = 25).
export function classMultiplierForSlot(
  slotRank: number,
  input: ClassStrengthInput | undefined,
): number {
  const r1 = input?.r1_offensive_count;

  // No data → neutral. Years with unknown depth default to full value.
  if (r1 === null || r1 === undefined) return 1.0;

  const past = Math.max(0, slotRank - r1);
  let mult = Math.max(
    DEPTH_FLOOR,
    Math.min(DEPTH_CEIL, 1 - DEPTH_DECAY_PER_SLOT * past),
  );

  // Elite head boost — only meaningful for the top 5 picks.
  const elite = input?.top15_offensive_count;
  if (slotRank <= 5 && elite !== null && elite !== undefined) {
    const eliteDelta = elite - BASELINE_TOP15_OFFENSE_COUNT;
    const headWeight = (6 - slotRank) / 5; // 1.0 at slot 1, 0.2 at slot 5
    mult *= 1 + ELITE_BOOST_PER_COUNT * eliteDelta * headWeight;
  }

  return Math.max(DEPTH_FLOOR, Math.min(ELITE_TOTAL_CAP, mult));
}

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
// `classOverrides` carries per-year depth signal from public.class_strength.
// Missing entries default to neutral (1.0 multiplier).
export function pickDpv(
  year: number,
  round: 1 | 2 | 3,
  slot: number,
  windowBase: number,
  classOverrides?: Record<number, ClassStrengthInput>,
): number {
  const key = `${round}.${String(slot).padStart(2, "0")}`;
  const curve = PICK_CURVE[key];
  if (curve === undefined) return 0;
  const distance = Math.max(0, year - windowBase);
  if (distance > 2) return 0;
  const distMult = YEAR_DISTANCE_MULTIPLIER[distance as 0 | 1 | 2] ?? 0;
  const slotRank = (round - 1) * 12 + slot;
  const classMult = classMultiplierForSlot(slotRank, classOverrides?.[year]);
  return Math.round(BASELINE_1_01_DPV * curve * distMult * classMult);
}
