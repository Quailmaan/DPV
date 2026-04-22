import { ageModifier } from "./age";
import { calculateBPS, weeklyCoefficientOfVariation } from "./bps";
import {
  SCORING_FORMAT_WEIGHTS,
  marketBlendWeights,
  scarcityMultiplier,
} from "./constants";
import { hsmBlendWeight, runHSM } from "./hsm";
import { calculateOpportunityScore } from "./opportunity";
import {
  boomBustModifier,
  olineModifier,
  qbQualityModifier,
} from "./situation";
import type { DPVBreakdown, DPVInput, DPVResult } from "./types";

const DPV_SCALE_CONSTANT = 380;
const DPV_MAX = 10000;

function classifyTier(dpv: number): string {
  if (dpv >= 7500) return "Elite";
  if (dpv >= 5000) return "Strong Starter";
  if (dpv >= 2500) return "Flex/Depth";
  if (dpv >= 1000) return "Bench Stash";
  return "Replacement";
}

export function calculateDPV(input: DPVInput): DPVResult {
  const { profile, seasons, opportunity, situation, scoringFormat } = input;
  const { position, age } = profile;

  const bps = calculateBPS(seasons, position, scoringFormat);
  const am = ageModifier(position, age);
  const os = calculateOpportunityScore(position, opportunity);
  const olqi = olineModifier(position, situation.teamOLineCompositeRank);
  const qqs = qbQualityModifier(position, situation);

  const mostRecent = [...seasons].sort((a, b) => b.season - a.season)[0];
  const cv = weeklyCoefficientOfVariation(mostRecent?.weeklyFantasyPoints);
  const bbcs = boomBustModifier(cv);

  const sfw = SCORING_FORMAT_WEIGHTS[position][scoringFormat];

  const dpvRaw = bps * am * os * olqi * qqs * bbcs * sfw;

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
    ? scarcityMultiplier(input.positionRank)
    : 1.0;
  const scaled = dpvFinal * scarcity;
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
    tier: classifyTier(normalized),
    breakdown,
  };
}
