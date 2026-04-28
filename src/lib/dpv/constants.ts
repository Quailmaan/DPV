import type { Position, ScoringFormat, QBTier, QBTransition } from "./types";

export const CURRENT_SEASON = 2025;

// Per-season trust factor based on games played. 15-17 = treated as a full
// year (random 1-2 game injuries shouldn't punish a healthy year). Below
// that, the sample shrinks and we downweight toward PPG noise.
export function gameReliability(games: number): number {
  if (games >= 15) return 1.0;
  if (games >= 13) return 0.95;
  if (games >= 10) return 0.85;
  return 0.72;
}

export const PPG_SCORING: Record<
  ScoringFormat,
  {
    rushYd: number;
    recYd: number;
    passYd: number;
    rushTD: number;
    recTD: number;
    passTD: number;
    reception: number;
    interception: number;
    fumbleLost: number;
  }
> = {
  STANDARD: {
    rushYd: 0.1,
    recYd: 0.1,
    passYd: 0.04,
    rushTD: 6,
    recTD: 6,
    passTD: 4,
    reception: 0,
    interception: -2,
    fumbleLost: -2,
  },
  HALF_PPR: {
    rushYd: 0.1,
    recYd: 0.1,
    passYd: 0.04,
    rushTD: 6,
    recTD: 6,
    passTD: 4,
    reception: 0.5,
    interception: -2,
    fumbleLost: -2,
  },
  FULL_PPR: {
    rushYd: 0.1,
    recYd: 0.1,
    passYd: 0.04,
    rushTD: 6,
    recTD: 6,
    passTD: 4,
    reception: 1.0,
    interception: -2,
    fumbleLost: -2,
  },
};

export const BPS_WEIGHTS: Record<Position, [number, number, number]> = {
  RB: [0.55, 0.3, 0.15],
  WR: [0.5, 0.3, 0.2],
  TE: [0.45, 0.3, 0.25],
  QB: [0.45, 0.3, 0.25],
};

export const AGE_MODIFIERS: Record<Position, Record<number, number>> = {
  RB: {
    21: 1.1,
    22: 1.15,
    23: 1.2,
    24: 1.22,
    25: 1.18,
    26: 1.08,
    27: 0.9,
    28: 0.75,
    29: 0.55,
    30: 0.35,
    31: 0.2,
  },
  WR: {
    21: 1.08,
    22: 1.15,
    23: 1.22,
    24: 1.25,
    25: 1.25,
    26: 1.22,
    27: 1.15,
    28: 1.05,
    29: 0.95,
    30: 0.88,
    31: 0.78,
    32: 0.6,
    33: 0.4,
  },
  TE: {
    21: 0.7,
    22: 0.7,
    23: 0.9,
    24: 1.05,
    25: 1.2,
    26: 1.22,
    27: 1.18,
    28: 1.08,
    29: 0.95,
    30: 0.85,
    31: 0.7,
    32: 0.55,
    33: 0.35,
  },
  QB: {
    21: 0.8,
    22: 0.85,
    23: 0.9,
    24: 0.95,
    25: 1.0,
    26: 1.03,
    27: 1.07,
    28: 1.1,
    29: 1.1,
    30: 1.1,
    31: 1.08,
    32: 1.05,
    33: 0.95,
    34: 0.9,
    35: 0.82,
    36: 0.7,
  },
};

export const OPPORTUNITY_WEIGHTS: Record<
  Exclude<Position, "QB">,
  { wSnap: number; wTouch: number; wVac: number }
> = {
  RB: { wSnap: 0.3, wTouch: 0.45, wVac: 0.25 },
  WR: { wSnap: 0.25, wTouch: 0.55, wVac: 0.2 },
  TE: { wSnap: 0.3, wTouch: 0.5, wVac: 0.2 },
};

export function snapShareScore(snapPct: number): number {
  if (snapPct >= 80) return 1.0;
  if (snapPct >= 70) return 0.85;
  if (snapPct >= 60) return 0.7;
  if (snapPct >= 50) return 0.5;
  if (snapPct >= 40) return 0.3;
  return 0.15;
}

export function targetShareScore(targetPct: number): number {
  if (targetPct >= 25) return 1.0;
  if (targetPct >= 20) return 0.85;
  if (targetPct >= 15) return 0.65;
  if (targetPct >= 10) return 0.4;
  return 0.15;
}

export function opportunityShareScore(oppPct: number): number {
  if (oppPct >= 70) return 1.0;
  if (oppPct >= 55) return 0.85;
  if (oppPct >= 40) return 0.65;
  if (oppPct >= 25) return 0.4;
  return 0.15;
}

export function vacancyBonusScore(absorbedPct: number): number {
  if (absorbedPct >= 15) return 1.0;
  if (absorbedPct >= 10) return 0.75;
  if (absorbedPct >= 5) return 0.5;
  if (absorbedPct >= 1) return 0.25;
  return 0.0;
}

export const OLQI_MULTIPLIERS: Record<
  Position,
  (rank: number) => number
> = {
  RB: (rank) => {
    if (rank <= 5) return 1.15;
    if (rank <= 10) return 1.06;
    if (rank <= 16) return 1.0;
    if (rank <= 22) return 0.95;
    if (rank <= 27) return 0.9;
    return 0.82;
  },
  WR: (rank) => {
    if (rank <= 5) return 1.03;
    if (rank <= 10) return 1.02;
    if (rank <= 16) return 1.0;
    if (rank <= 22) return 0.99;
    if (rank <= 27) return 0.97;
    return 0.95;
  },
  QB: (rank) => {
    if (rank <= 5) return 1.02;
    if (rank <= 10) return 1.01;
    if (rank <= 22) return 1.0;
    if (rank <= 27) return 0.99;
    return 0.98;
  },
  TE: () => 1.0,
};

export const QQS_MULTIPLIERS: Record<
  Position,
  Record<QBTier, number>
> = {
  WR: { 1: 1.08, 2: 1.04, 3: 1.0, 4: 0.94, 5: 0.88 },
  TE: { 1: 1.06, 2: 1.03, 3: 1.0, 4: 0.96, 5: 0.92 },
  RB: { 1: 1.02, 2: 1.01, 3: 1.0, 4: 0.99, 5: 0.98 },
  QB: { 1: 1.0, 2: 1.0, 3: 1.0, 4: 1.0, 5: 1.0 },
};

export const QB_TRANSITION_ADJUSTMENTS: Record<QBTransition, number> = {
  STABLE: 0,
  KNOWN_UPGRADE: 0.03,
  LATERAL: 0,
  KNOWN_DOWNGRADE: -0.05,
  UNKNOWN_ROOKIE: -0.08,
};

export const BBCS_SCALING: Record<Position, number> = {
  RB: 0.15,
  WR: 0.2,
  TE: 0.2,
  QB: 0.1,
};

export function bbcsModifier(cv: number): number {
  if (cv < 0.3) return 1.08;
  if (cv < 0.46) return 1.04;
  if (cv < 0.61) return 1.0;
  if (cv < 0.81) return 0.96;
  return 0.92;
}

export const SCORING_FORMAT_WEIGHTS: Record<
  Position,
  Record<ScoringFormat, number>
> = {
  QB: { STANDARD: 1.0, HALF_PPR: 1.0, FULL_PPR: 1.0 },
  RB: { STANDARD: 1.0, HALF_PPR: 1.05, FULL_PPR: 1.1 },
  WR: { STANDARD: 0.95, HALF_PPR: 1.0, FULL_PPR: 1.08 },
  TE: { STANDARD: 0.9, HALF_PPR: 0.95, FULL_PPR: 1.05 },
};

// Position-aware scarcity. Calibrated for the platform default —
// 12-team 1QB / 2RB / 2WR / 1TE / 2 FLEX. The starter pool size
// determines where the cliff sits:
//
//   QB ≈ 12 starters       → sharp cliff at rank 12, hard floor below
//   TE ≈ 13 starters       → similar shape, slight elite-tier premium
//   RB ≈ 35 starters       → broad starter pool through rank 36
//   WR ≈ 35 starters       → similar to RB, slightly deeper PPR tail
//
// In 1QB the value of any QB past rank 12 collapses fast — QB13 is a
// streamer, QB25 is roster filler. Meanwhile the 24th RB is still a
// flex-eligible starter every week. The old single-curve formula (rank
// 6 = 1.10, rank 12 = 1.00, rank 25 = 0.80) over-rewarded mid-pack QBs
// vs. mid-pack RBs/WRs and produced the canonical "Mac Jones > Quinshon
// Judkins" wrongness. Top-tier QBs are still valuable but capped at
// 0.95 — they don't outweigh a top-tier RB the way the previous curve
// allowed.
//
// Superflex / 2QB leagues need a different QB curve. Today the rankings
// table is calibrated as 1QB across the board; the SF adjustment is a
// runtime multiplier on the league page (TODO — uses
// isSuperflexConstruction from scarcity.ts).
export function scarcityMultiplier(
  position: Position,
  positionRank: number,
): number {
  switch (position) {
    case "QB":
      if (positionRank <= 3) return 0.95;
      if (positionRank <= 6) return 0.78;
      if (positionRank <= 12) return 0.62;
      if (positionRank <= 18) return 0.4;
      if (positionRank <= 24) return 0.22;
      return 0.12;
    case "TE":
      if (positionRank <= 3) return 1.22;
      if (positionRank <= 6) return 1.1;
      if (positionRank <= 12) return 1.0;
      if (positionRank <= 20) return 0.78;
      if (positionRank <= 30) return 0.55;
      return 0.4;
    case "RB":
      if (positionRank <= 6) return 1.18;
      if (positionRank <= 12) return 1.1;
      if (positionRank <= 24) return 1.02;
      if (positionRank <= 36) return 0.92;
      if (positionRank <= 48) return 0.78;
      return 0.62;
    case "WR":
      if (positionRank <= 6) return 1.18;
      if (positionRank <= 12) return 1.1;
      if (positionRank <= 24) return 1.02;
      if (positionRank <= 36) return 0.92;
      if (positionRank <= 50) return 0.78;
      return 0.65;
  }
}

export function marketBlendWeights(
  age: number,
  position: Position,
  yearsPro: number,
): { model: number; market: number } {
  if (yearsPro < 2) return { model: 0.8, market: 0.2 };
  const postPrime =
    (position === "RB" && age >= 28) ||
    (position === "WR" && age >= 31) ||
    (position === "TE" && age >= 30) ||
    (position === "QB" && age >= 35);
  if (postPrime) return { model: 0.55, market: 0.45 };
  return { model: 0.65, market: 0.35 };
}

export function multiYearWeights(
  age: number,
): [number, number, number, number, number] {
  if (age <= 24) return [0.25, 0.25, 0.25, 0.15, 0.1];
  if (age <= 28) return [0.35, 0.25, 0.2, 0.12, 0.08];
  return [0.5, 0.25, 0.15, 0.07, 0.03];
}
