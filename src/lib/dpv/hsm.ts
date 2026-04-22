import type { DPVInput } from "./types";

export interface HSMResult {
  projectedPPG: number | null;
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  blendWeight: number;
  analogs: Array<{ name: string; similarity: number; season: number }>;
}

export function runHSM(_input: DPVInput): HSMResult {
  return {
    projectedPPG: null,
    confidence: "NONE",
    blendWeight: 1.0,
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
