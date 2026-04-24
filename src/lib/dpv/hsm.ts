import type { DPVInput } from "./types";

export interface HSMResult {
  projectedPPG: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  blendWeight: number;
  analogs: Array<{ name: string; similarity: number; season: number }>;
}

export function runHSM(input: DPVInput): HSMResult {
  const pre = input.precomputedHSM;
  if (!pre || pre.n === 0 || pre.meanNextPPG === null) {
    return {
      projectedPPG: null,
      confidence: "NONE",
      blendWeight: 1.0,
      analogs: [],
    };
  }
  let confidence: HSMResult["confidence"] =
    pre.n >= 6 ? "HIGH" : pre.n >= 4 ? "MEDIUM" : "LOW";
  // QBs with <3 qualifying seasons have noisy track records — cap HSM
  // confidence so more weight falls on the comp-projected PPG, not their
  // thin raw sample.
  if (input.profile.position === "QB" && input.seasons.length < 3) {
    if (confidence === "HIGH") confidence = "MEDIUM";
  }
  // Prefer the v2 multi-year similarity-weighted projection (0.5/0.3/0.2
  // across t+1/t+2/t+3). Falls back to the legacy median/mean blend for
  // hsm_comps rows written before v2.
  const projectedPPG =
    pre.projectedPPG !== null && pre.projectedPPG !== undefined
      ? pre.projectedPPG
      : pre.medianNextPPG !== null
        ? 0.6 * pre.medianNextPPG + 0.4 * pre.meanNextPPG
        : pre.meanNextPPG;
  return {
    projectedPPG,
    confidence,
    blendWeight: hsmBlendWeight(confidence),
    analogs: [],
  };
}

export function hsmBlendWeight(
  confidence: HSMResult["confidence"],
): number {
  switch (confidence) {
    case "HIGH":
      return 0.6;
    case "MEDIUM":
      return 0.75;
    case "LOW":
      return 0.9;
    case "NONE":
      return 1.0;
  }
}
