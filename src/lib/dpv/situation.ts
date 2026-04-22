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
