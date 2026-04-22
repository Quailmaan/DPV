import {
  OPPORTUNITY_WEIGHTS,
  opportunityShareScore,
  snapShareScore,
  targetShareScore,
  vacancyBonusScore,
} from "./constants";
import type { OpportunityInputs, Position } from "./types";

export function calculateOpportunityScore(
  position: Position,
  inputs: OpportunityInputs,
): number {
  if (position === "QB") return 1.0;

  const weights = OPPORTUNITY_WEIGHTS[position];
  const snap = snapShareScore(inputs.snapSharePct);

  let touch: number;
  if (position === "RB") {
    touch = opportunityShareScore(inputs.opportunitySharePct ?? 0);
  } else {
    touch = targetShareScore(inputs.targetSharePct ?? 0);
  }

  const vacancyInheritance =
    (inputs.teamVacatedTargetPct ?? 0) *
    (inputs.projectedAbsorptionRate ?? 0);
  const vac = vacancyBonusScore(vacancyInheritance);

  return snap * weights.wSnap + touch * weights.wTouch + vac * weights.wVac;
}
