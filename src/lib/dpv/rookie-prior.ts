import type { Position, QBTier, ScoringFormat } from "./types";

// Rookie prior DPV — used when a player has zero qualifying NFL seasons
// (no 7+ game year on record). Once a player logs a qualifying season, BPS
// takes over and the prior is ignored.
//
// Signal sources (ranked by weight):
//   1. Draft capital (round) — strongest predictor of rookie-year opportunity
//      and multi-year investment from the team.
//   2. Position — different dynasty shelf lives and scoring ceilings.
//   3. Landing spot — team OL rank (RBs, QBs) and team QB tier (pass-catchers).
//   4. Age at draft — older rookies have less development runway.
//
// Values are calibrated to the existing DPV scale (Puka ≈ 7131, mid-tier ~3000).
// Restricted to offensive skill positions (QB/RB/WR/TE) per product scope.

// Base prior by (position, round). Round 1 split into early (picks 1–16) and
// late (17–32) — but we only get `round` from our players table today, so v1
// uses a single R1 value. Refine if we start ingesting `overall_pick`.
const BASE_BY_POSITION_ROUND: Record<Position, Record<number, number>> = {
  QB: {
    1: 5500, // franchise QB investment — multi-year starter runway
    2: 2200, // developmental, bridge potential
    3: 1200,
    4: 700,
    5: 400,
    6: 250,
    7: 150,
  },
  RB: {
    1: 5200, // bellcow investment — 3-year window
    2: 3400,
    3: 2000,
    4: 1100,
    5: 600,
    6: 350,
    7: 200,
  },
  WR: {
    1: 4800, // immediate WR2 floor, WR1 ceiling
    2: 3200,
    3: 1800,
    4: 1000,
    5: 550,
    6: 300,
    7: 180,
  },
  TE: {
    1: 3400, // 3-year dev curve, TE1 ceiling
    2: 1900,
    3: 1000,
    4: 600,
    5: 350,
    6: 200,
    7: 120,
  },
};

// UDFA / undrafted (no round recorded) gets a token value — plausible depth
// flier, nothing more.
const UDFA_BY_POSITION: Record<Position, number> = {
  QB: 100,
  RB: 200,
  WR: 250,
  TE: 120,
};

// Scoring-format multipliers. QB/RB barely change; WR/TE swing with PPR.
const FORMAT_MULT: Record<Position, Record<ScoringFormat, number>> = {
  QB: { STANDARD: 1.0, HALF_PPR: 1.0, FULL_PPR: 1.0 },
  RB: { STANDARD: 1.05, HALF_PPR: 1.0, FULL_PPR: 0.95 },
  WR: { STANDARD: 0.9, HALF_PPR: 1.0, FULL_PPR: 1.08 },
  TE: { STANDARD: 0.92, HALF_PPR: 1.0, FULL_PPR: 1.06 },
};

function oLineAdjust(position: Position, oLineRank: number): number {
  // Good OL helps RBs most, QBs secondarily, pass-catchers mildly.
  const pct = (16.5 - oLineRank) / 16.5; // -1..+1
  const sensitivity = position === "RB" ? 0.1 : position === "QB" ? 0.05 : 0.03;
  return 1 + pct * sensitivity;
}

function qbTierAdjust(position: Position, qbTier: QBTier): number {
  // Only matters for pass-catchers. Tier 1 (elite) = boost; tier 5 (bad) = hit.
  if (position !== "WR" && position !== "TE") return 1.0;
  const map: Record<QBTier, number> = {
    1: 1.1,
    2: 1.05,
    3: 1.0,
    4: 0.92,
    5: 0.85,
  };
  return map[qbTier] ?? 1.0;
}

function ageAdjust(age: number | null): number {
  if (age === null) return 1.0;
  // Normal rookie age band: 21–23. Older rookies = less runway.
  if (age <= 21.5) return 1.03;
  if (age <= 22.5) return 1.0;
  if (age <= 23.5) return 0.96;
  if (age <= 24.5) return 0.9;
  return 0.82;
}

export type RookiePriorInput = {
  position: Position;
  draftRound: number | null;
  ageAtDraft: number | null;
  teamOLineRank: number | null;
  qbTier: QBTier | null;
  scoringFormat: ScoringFormat;
};

export type RookiePriorResult = {
  dpv: number;
  breakdown: {
    kind: "rookie_prior";
    base: number;
    oLineMult: number;
    qbTierMult: number;
    ageMult: number;
    formatMult: number;
  };
};

export function computeRookiePrior(
  input: RookiePriorInput,
): RookiePriorResult {
  const base =
    input.draftRound === null
      ? UDFA_BY_POSITION[input.position]
      : (BASE_BY_POSITION_ROUND[input.position]?.[input.draftRound] ??
          UDFA_BY_POSITION[input.position]);

  const oLineMult = oLineAdjust(input.position, input.teamOLineRank ?? 16);
  const qbTierMult = qbTierAdjust(input.position, (input.qbTier ?? 3) as QBTier);
  const ageMult = ageAdjust(input.ageAtDraft);
  const formatMult = FORMAT_MULT[input.position][input.scoringFormat];

  const dpv = Math.round(base * oLineMult * qbTierMult * ageMult * formatMult);

  return {
    dpv,
    breakdown: {
      kind: "rookie_prior",
      base,
      oLineMult: Number(oLineMult.toFixed(3)),
      qbTierMult: Number(qbTierMult.toFixed(3)),
      ageMult: Number(ageMult.toFixed(3)),
      formatMult: Number(formatMult.toFixed(3)),
    },
  };
}

// Tier naming for rookie priors — separate from the veteran tier system so the
// UI can show "Rookie — R1 Prior" etc. and readers know this is forward-looking.
export function rookiePriorTier(
  position: Position,
  draftRound: number | null,
): string {
  if (draftRound === null) return `Rookie ${position} UDFA`;
  if (draftRound === 1) return `Rookie ${position} R1`;
  if (draftRound === 2) return `Rookie ${position} R2`;
  if (draftRound <= 4) return `Rookie ${position} Day 2/3`;
  return `Rookie ${position} Late`;
}
