import type { Position } from "./types";

// Position-specific EPA-per-opportunity multiplier for PYV. Captures
// the "skill" component of per-attempt production that the existing
// opportunity score (which only weights *how many* opportunities)
// misses.
//
// Slots into the multiplier chain in dpv.ts as a final modifier
// alongside age, opportunity, OL, QB quality, and boom/bust. Bounded
// to [0.85, 1.15] so it can re-rank adjacent tiers (an elite-efficiency
// RB1 climbing past a less efficient RB1) without dominating the
// volume signal — a high-snap mediocre WR is still ranked above a
// niche-role efficient one.
//
// Centering constants (median, spread) below were derived from the
// 2024 nflverse seasonal aggregates printed by
// scripts/inspect-advanced-stats.ts. Re-calibrate periodically by
// re-running that script — RB drifts year-to-year as scheme trends
// shift league-wide rushing efficiency.

export interface EfficiencyInputs {
  // Player's most-recent-season per-opportunity EPA. Position-specific:
  //   QB → passing_epa / dropback
  //   RB → rushing_epa / carry
  //   WR/TE → receiving_epa / target
  // null when the player has no advanced-stats record (rookies, deep
  // depth-chart pieces) — caller can pass null and we'll return 1.0.
  epaPerOpportunity: number | null;

  // Sample size — opportunities that produced the EPA. Below the
  // position-specific MIN_OPPS threshold we treat efficiency as
  // neutral (1.0×) because small-sample EPA is dominated by variance,
  // not skill: a rookie WR with 4 targets and one 50-yard TD shows
  // EPA-per-target an order of magnitude above any real player.
  //   QB → dropbacks, RB → carries, WR/TE → targets
  opportunities: number;
}

// ~3 games of starter-level usage per position. Tuned to include
// real role players while filtering the rotational noise.
const MIN_OPPS: Record<Position, number> = {
  QB: 100,
  RB: 50,
  WR: 30,
  TE: 25,
};

// Centering: an average player at this position lands at the median,
// where the multiplier is exactly 1.0×. Spread sets how aggressively
// above-/below-median players move toward the multiplier band edges.
//
// Calibrated from 2024 nflverse seasonal aggregates over players who
// met MIN_OPPS:
//   QB:  p50=+0.015, p10=-0.224, p90=+0.190 → median ~0,    spread ~0.20
//   RB:  p50=-0.079, p10=-0.214, p90=+0.067 → median ~-0.08, spread ~0.15
//   WR:  p50=+0.239, p10=-0.101, p90=+0.580 → median ~+0.24, spread ~0.35
//   TE:  p50=+0.247, p10=-0.026, p90=+0.530 → median ~+0.25, spread ~0.30
//
// Test cases confirm the band:
//   Lamar Jackson @ 0.363  → z=1.7, mult≈1.14 (~14% bonus)
//   league-avg QB          → z=0,   mult=1.00
//   Drew Lock @ -0.230     → z=-1.25, mult≈0.87 (~13% penalty)
const CENTERING: Record<Position, { median: number; spread: number }> = {
  QB: { median: 0.02, spread: 0.2 },
  RB: { median: -0.08, spread: 0.15 },
  WR: { median: 0.24, spread: 0.35 },
  TE: { median: 0.25, spread: 0.3 },
};

// Maximum deviation in either direction. 15% chosen so efficiency is
// strong enough to reorder adjacent tiers but never overwhelms the
// underlying production score — a 10x raw-yards player on a bad team
// is still more valuable than a niche-role efficient player.
const MAX_BAND = 0.15;

/**
 * Compute the position-specific efficiency multiplier (0.85-1.15)
 * to slot into the PYV modifier chain.
 *
 * Returns 1.0 (neutral) when the player has no advanced-stats record
 * or insufficient sample size. We never *penalize* for missing data —
 * a depth-chart rookie with 8 targets shouldn't lose value just
 * because we can't measure his efficiency yet.
 */
export function efficiencyMultiplier(
  position: Position,
  inputs: EfficiencyInputs | undefined,
): number {
  if (!inputs) return 1.0;
  if (inputs.epaPerOpportunity === null) return 1.0;
  if (inputs.opportunities < MIN_OPPS[position]) return 1.0;

  const c = CENTERING[position];
  // Tanh-scaled. Bounds output to ±MAX_BAND with smooth saturation
  // so freak outliers (e.g. Adam Thielen's 0.65 EPA/target on 62
  // targets) don't produce outsized swings — they cap at the same
  // ~14% bonus as a more sustained elite season.
  const z = (inputs.epaPerOpportunity - c.median) / c.spread;
  return 1.0 + Math.tanh(z) * MAX_BAND;
}
