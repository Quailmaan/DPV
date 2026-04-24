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
  // Seasons completed since draft without a qualifying (7+ game) year.
  // 0 = incoming class or rookie year not yet played out.
  // 1 = one rookie season burned without a qualifying year.
  // 2+ = multi-year wash — the prior should be heavily lapsed.
  missedSeasons?: number;
  // Max games played across any season on record (incl. sub-7 games).
  // Used to distinguish "IR'd all year" (0) from "flashed, then hurt" (3-6).
  maxGamesPlayed?: number;
  // How many same-team, same-position rookies in the same draft class were
  // drafted earlier (lower overall pick). 0 = alone or highest-drafted at the
  // position. 1 = second in stack. Docks Year-1 opportunity expectations
  // because depth-chart reality caps touches regardless of draft capital.
  intraClassDepthIdx?: number;
  // Post-draft displacement from same-team same-position rookies in the
  // CURRENT class. For lapsed rookies (missedSeasons >= 1) — fresh rookies
  // get intraClassDepth instead, so they don't double-dock.
  rookieDisplacementMult?: number;
  // 0-10 athleticism composite from combine_stats.athleticism_score.
  // Null/undefined = no combine data → neutral 1.0× mult.
  athleticismScore?: number | null;
  // HSM-derived projection (similarity-weighted Y1/Y2/Y3 half-PPR PPG blend)
  // from compute-rookie-hsm.ts. When present, blends into the final prior so
  // historically-comparable outcomes pull the multiplicative DPV toward the
  // empirical distribution. Null = no comps available → blend skipped.
  hsmProjectedPPG?: number | null;
  // Effective comp count for this rookie (top-K, capped by pool size).
  // Drives the HSM blend weight — fewer comps = less confidence.
  hsmN?: number;
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
    lapseMult: number;
    intraClassDepthMult: number;
    rookieDisplacementMult: number;
    combineMult: number;
    athleticismScore: number | null;
    missedSeasons: number;
    // HSM blend diagnostics (null = HSM skipped).
    hsmMult: number;
    hsmProjectedPPG: number | null;
    hsmN: number;
    hsmWeight: number;
    preHsmDPV: number;
  };
};

// Decay applied when a drafted rookie has failed to log a qualifying season.
// The prior assumes "team invested draft capital, player will produce" — each
// year that passes without that production is strong evidence against it.
function lapseMultiplier(missedSeasons: number, maxGamesPlayed: number): number {
  if (missedSeasons <= 0) return 1.0;
  if (missedSeasons === 1) {
    // One rookie year burned. Distinguish zero games (likely IR/redshirt) from
    // a partial season (tried and faded). Either way, sizable decay.
    return maxGamesPlayed >= 3 ? 0.55 : 0.45;
  }
  if (missedSeasons === 2) return 0.22;
  // 3+ missed seasons — at this point a rookie prior is largely fiction.
  return 0.1;
}

// Dock rookies who are stacked behind same-team same-position peers in the
// same draft class. depthIdx = # of same-team/pos rookies drafted earlier.
// Depth-chart reality caps Year-1 opportunity regardless of capital — the
// second RB a team takes in a class rarely gets workhorse touches.
export function intraClassDepthAdjust(depthIdx: number): number {
  if (depthIdx <= 0) return 1.0;
  if (depthIdx === 1) return 0.55;
  if (depthIdx === 2) return 0.35;
  return 0.25;
}

// Convert a similarity-weighted Y1/Y2/Y3 half-PPR PPG projection into an
// equivalent DPV. The mapping is a mild power curve (PPG^1.6 × 50) calibrated
// so 20 PPG ≈ 6000 DPV (workhorse RB/WR1), 10 PPG ≈ 2000 DPV (flex starter),
// 5 PPG ≈ 650 DPV (bench depth). QBs get a slight discount — 20 PPG is less
// rare at QB — and TEs a small premium to reflect positional scarcity.
export function hsmProjectionToDPV(ppg: number, position: Position): number {
  const base = Math.pow(Math.max(0, ppg), 1.6) * 50;
  const posAdj =
    position === "QB" ? 0.85 : position === "TE" ? 1.1 : 1.0;
  return Math.max(0, Math.min(8000, base * posAdj));
}

// Blend weight grows with comp count. Caps at 0.4 — even with 8 perfect
// comps, the structural prior (draft capital, landing spot, age) remains
// the dominant signal.
export function hsmBlendWeightFromCount(n: number): number {
  if (n <= 0) return 0;
  if (n >= 8) return 0.4;
  return 0.05 * n;
}

// Combine/RAS adjustment. athleticism_score is 0-10 (position-normalized),
// derived in ingest-combine.ts. Kept conservative — athletic profile moves
// outcomes but draft capital remains the dominant signal. Null = no combine
// data on record → neutral.
export function combineAdjust(score: number | null | undefined): number {
  if (score === null || score === undefined) return 1.0;
  if (score >= 9) return 1.15;
  if (score >= 7.5) return 1.08;
  if (score >= 6) return 1.03;
  if (score >= 4) return 1.0;
  if (score >= 2.5) return 0.95;
  return 0.88;
}

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
  const missed = input.missedSeasons ?? 0;
  const lapseMult = lapseMultiplier(missed, input.maxGamesPlayed ?? 0);

  // Fresh rookies (missed=0) use intraClassDepth; lapsed rookies have already
  // been absorbed into the team and instead face displacement from NEW rookies.
  const intraClassDepthMult =
    missed === 0 ? intraClassDepthAdjust(input.intraClassDepthIdx ?? 0) : 1.0;
  const displacementMult =
    missed >= 1 ? input.rookieDisplacementMult ?? 1.0 : 1.0;
  const combineMult = combineAdjust(input.athleticismScore);

  const preHsmDPV =
    base *
    oLineMult *
    qbTierMult *
    ageMult *
    formatMult *
    lapseMult *
    intraClassDepthMult *
    displacementMult *
    combineMult;

  // HSM blend — if nearest-neighbor rookies with similar pre-draft profiles
  // produced around X PPG over their first three years, pull the structural
  // prior toward the PPG-equivalent DPV. Weight scales with comp count, caps
  // at 0.4 so draft capital / landing spot remain the dominant signal.
  //
  // Fresh rookies only (missed === 0). Lapsed rookies already have Y1 non-
  // production as observed evidence against the pre-draft profile — blending
  // in "what similar prospects did Y1/Y2/Y3" would paper over that signal and
  // fight the lapseMult directionally.
  const hsmPPG = input.hsmProjectedPPG ?? null;
  const hsmN = input.hsmN ?? 0;
  let hsmMult = 1.0;
  let hsmWeight = 0;
  let finalDPV = preHsmDPV;
  if (missed === 0 && hsmPPG !== null && hsmN > 0 && preHsmDPV > 0) {
    hsmWeight = hsmBlendWeightFromCount(hsmN);
    if (hsmWeight > 0) {
      const hsmDPV = hsmProjectionToDPV(hsmPPG, input.position);
      finalDPV = preHsmDPV * (1 - hsmWeight) + hsmDPV * hsmWeight;
      hsmMult = finalDPV / preHsmDPV;
    }
  }

  return {
    dpv: Math.round(finalDPV),
    breakdown: {
      kind: "rookie_prior",
      base,
      oLineMult: Number(oLineMult.toFixed(3)),
      qbTierMult: Number(qbTierMult.toFixed(3)),
      ageMult: Number(ageMult.toFixed(3)),
      formatMult: Number(formatMult.toFixed(3)),
      lapseMult: Number(lapseMult.toFixed(3)),
      intraClassDepthMult: Number(intraClassDepthMult.toFixed(3)),
      rookieDisplacementMult: Number(displacementMult.toFixed(3)),
      combineMult: Number(combineMult.toFixed(3)),
      athleticismScore:
        input.athleticismScore !== null && input.athleticismScore !== undefined
          ? Number(input.athleticismScore)
          : null,
      missedSeasons: missed,
      hsmMult: Number(hsmMult.toFixed(3)),
      hsmProjectedPPG: hsmPPG !== null ? Number(hsmPPG) : null,
      hsmN,
      hsmWeight: Number(hsmWeight.toFixed(3)),
      preHsmDPV: Math.round(preHsmDPV),
    },
  };
}

// Tier naming for rookie priors — separate from the veteran tier system so the
// UI can show readers that this value is forward-looking, and distinguishes
// fresh rookies from players with draft capital who haven't produced.
export function rookiePriorTier(
  position: Position,
  draftRound: number | null,
  missedSeasons: number = 0,
): string {
  const capital =
    draftRound === null
      ? "Undrafted"
      : draftRound === 1
        ? "1st-Round"
        : draftRound === 2
          ? "2nd-Round"
          : draftRound <= 4
            ? "Day 2/3"
            : "Late-Round";
  // Past their rookie year without qualifying — they're no longer "rookies"
  // in the dynasty sense. Drop the word and describe the state instead.
  if (missedSeasons >= 2) return `Lapsed ${capital} ${position}`;
  if (missedSeasons === 1) return `Stalled ${capital} ${position}`;
  return `${capital} Rookie ${position}`;
}
