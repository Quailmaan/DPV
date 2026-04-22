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
  const confidence: HSMResult["confidence"] =
    pre.n >= 6 ? "HIGH" : pre.n >= 4 ? "MEDIUM" : "LOW";
  // Use median (more robust to outlier comps) blended slightly toward mean.
  const projectedPPG =
    pre.medianNextPPG !== null
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
