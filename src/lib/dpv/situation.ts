import {
  OLQI_MULTIPLIERS,
  QB_TRANSITION_ADJUSTMENTS,
  QQS_MULTIPLIERS,
  bbcsModifier,
} from "./constants";
import type { Position, SituationInputs } from "./types";

export function olineModifier(
  position: Position,
  teamOLineCompositeRank: number,
): number {
  return OLQI_MULTIPLIERS[position](teamOLineCompositeRank);
}

export function qbQualityModifier(
  position: Position,
  situation: SituationInputs,
): number {
  const base = QQS_MULTIPLIERS[position][situation.qbTier];

  let multiplier = base;
  if (
    situation.qbTierPrevious !== undefined &&
    situation.qbTierPrevious === situation.qbTier
  ) {
    multiplier = 1.0 + (base - 1.0) * 0.35;
  }

  if (situation.qbTransition) {
    multiplier += QB_TRANSITION_ADJUSTMENTS[situation.qbTransition];
  }

  return multiplier;
}

export function boomBustModifier(cv: number | null): number {
  if (cv === null) return 1.0;
  return bbcsModifier(cv);
}

// Displacement dock from incoming rookies at the player's team+position.
// rookieThreatPPG = sum of draft-capital-curve meanYear1PPG across same-team
// same-position rookies in the current draft class (self excluded for rookies).
// priorYearShare = the player's own opportunity/target share last season (0..1).
//
// Calibration: a top-10 RB (~18 PPG threat) arriving at a team with a workhorse
// incumbent (60%+ share) docks ~45%. A late-round rookie (~2 PPG threat) against
// the same incumbent docks ~5%. Low-share incumbents (<30%) feel less of it
// because they had less to lose.
export function rookieDisplacementModifier(
  rookieThreatPPG: number,
  priorYearShare: number | null,
): number {
  if (rookieThreatPPG <= 0) return 1.0;
  const shareLoss = Math.min(0.6, rookieThreatPPG * 0.025);
  const shareWeight =
    priorYearShare !== null ? Math.min(1, priorYearShare / 0.5) : 0.5;
  return Math.max(0.4, 1 - shareLoss * shareWeight);
}
