import { ageModifier } from "./age";
import { calculateBPS, weeklyCoefficientOfVariation } from "./bps";
import {
  SCORING_FORMAT_WEIGHTS,
  marketBlendWeights,
  scarcityMultiplier,
} from "./constants";
import { efficiencyMultiplier } from "./efficiency";
import { hsmBlendWeight, runHSM } from "./hsm";
import { calculateOpportunityScore } from "./opportunity";
import {
  boomBustModifier,
  olineModifier,
  qbQualityModifier,
} from "./situation";
import type { DPVBreakdown, DPVInput, DPVResult, Position } from "./types";

const DPV_SCALE_CONSTANT = 380;
const DPV_MAX = 10000;

// Rank-based tiers (12-team league starter counts per position).
// Elite ≈ top starters, Weekly Starter ≈ rest of weekly starters,
// Flex Option ≈ flex/bench, Depth Piece ≈ deep roster, else Waiver Wire.
const TIER_THRESHOLDS: Record<
  Position,
  { elite: number; strong: number; flex: number; stash: number }
> = {
  QB: { elite: 6, strong: 14, flex: 24, stash: 36 },
  RB: { elite: 8, strong: 20, flex: 36, stash: 60 },
  WR: { elite: 12, strong: 30, flex: 50, stash: 80 },
  TE: { elite: 6, strong: 12, flex: 20, stash: 30 },
};

function classifyTier(
  position: Position,
  positionRank: number | undefined,
): string {
  if (!positionRank) return "Waiver Wire";
  const t = TIER_THRESHOLDS[position];
  if (positionRank <= t.elite) return "Elite";
  if (positionRank <= t.strong) return "Weekly Starter";
  if (positionRank <= t.flex) return "Flex Option";
  if (positionRank <= t.stash) return "Depth Piece";
  return "Waiver Wire";
}

export function calculateDPV(input: DPVInput): DPVResult {
  const { profile, seasons, opportunity, situation, scoringFormat } = input;
  const { position, age } = profile;

  const bps = calculateBPS(seasons, position, scoringFormat, input.asOfSeason);
  const am = ageModifier(position, age);
  const os = calculateOpportunityScore(position, opportunity);
  const olqi = olineModifier(position, situation.teamOLineCompositeRank);
  const qqs = qbQualityModifier(position, situation);

  const mostRecent = [...seasons].sort((a, b) => b.season - a.season)[0];
  const cv = weeklyCoefficientOfVariation(mostRecent?.weeklyFantasyPoints);
  const bbcs = boomBustModifier(cv);

  const sfw = SCORING_FORMAT_WEIGHTS[position][scoringFormat];

  // QB role-confidence multipliers. Both default 1.0 (no penalty) for
  // non-QBs and for QBs without enough evidence to penalize. They multiply
  // — a career backup on a team with a clear starter ahead of him eats
  // both. See types.ts for what each captures.
  const qbStarterRate = input.qbStarterRateMult ?? 1.0;
  const qbDepthChart = input.qbDepthChartMult ?? 1.0;

  // EPA-per-opportunity efficiency. Defaults to 1.0 (neutral) for
  // players with no advanced-stats record OR below the MIN_OPPS
  // sample threshold, so missing data never penalizes a player.
  // See efficiency.ts for the calibrated band [0.85, 1.15] and the
  // tanh-scaled position-specific centering.
  const eff = efficiencyMultiplier(position, input.efficiency);

  const dpvRaw =
    bps *
    am *
    os *
    olqi *
    qqs *
    bbcs *
    sfw *
    qbStarterRate *
    qbDepthChart *
    eff;

  const hsm = runHSM(input);
  const hsmBlend = hsmBlendWeight(hsm.confidence);
  const dpvProjected =
    hsm.projectedPPG !== null
      ? dpvRaw * hsmBlend + hsm.projectedPPG * (1 - hsmBlend)
      : dpvRaw;

  const yearsPro = seasons.length;
  const blend = marketBlendWeights(age, position, yearsPro);
  const market = input.marketValueNormalized;
  const dpvFinal =
    market !== undefined
      ? dpvProjected * blend.model + market * blend.market
      : dpvProjected;

  const scarcity = input.positionRank
    ? scarcityMultiplier(position, input.positionRank)
    : 1.0;
  const rookieDisplacement = input.rookieDisplacementMult ?? 1.0;
  const scaled = dpvFinal * scarcity * rookieDisplacement;
  const normalized = Math.max(
    0,
    Math.min(DPV_MAX, Math.round(scaled * DPV_SCALE_CONSTANT)),
  );

  const breakdown: DPVBreakdown = {
    bps,
    ageModifier: am,
    opportunityScore: os,
    olineModifier: olqi,
    qbQualityModifier: qqs,
    bbcsModifier: bbcs,
    scoringFormatWeight: sfw,
    scarcityMultiplier: scarcity,
    rookieDisplacementMult: rookieDisplacement,
    qbStarterRateMult: qbStarterRate,
    qbDepthChartMult: qbDepthChart,
    efficiencyMultiplier: eff,
    dpvRaw,
    dpvProjected,
    dpvFinal: scaled,
    dpvNormalized: normalized,
    hsmConfidence: hsm.confidence,
    hsmBlendWeight: hsmBlend,
    marketBlendWeight: blend.market,
  };

  return {
    playerId: profile.playerId,
    name: profile.name,
    position,
    age,
    dpv: normalized,
    tier: classifyTier(position, input.positionRank),
    breakdown,
  };
}
