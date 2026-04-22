import {
  BPS_WEIGHTS,
  CURRENT_SEASON,
  PPG_SCORING,
  gameReliability,
} from "./constants";
import type { Position, ScoringFormat, SeasonStats } from "./types";

export function seasonPPG(
  stats: SeasonStats,
  format: ScoringFormat,
): number {
  if (stats.gamesPlayed < 7) return 0;
  const s = PPG_SCORING[format];
  const total =
    stats.passingYards * s.passYd +
    stats.passingTDs * s.passTD +
    stats.rushingYards * s.rushYd +
    stats.rushingTDs * s.rushTD +
    stats.receivingYards * s.recYd +
    stats.receivingTDs * s.recTD +
    stats.receptions * s.reception +
    stats.interceptions * s.interception +
    stats.fumblesLost * s.fumbleLost;
  return total / stats.gamesPlayed;
}

export function calculateBPS(
  seasons: SeasonStats[],
  position: Position,
  format: ScoringFormat,
): number {
  // Hard recency window: a "3-year BPS" means the last 3 calendar years, not
  // "3 most recent seasons played." Skipping years shouldn't silently drag in
  // ancient production (e.g., Watson's 2019/2020 showing up in 2026 rankings).
  const qualifying = seasons
    .filter((s) => s.gamesPlayed >= 7)
    .filter((s) => s.season >= CURRENT_SEASON - 3)
    .sort((a, b) => b.season - a.season)
    .slice(0, 3);

  if (qualifying.length === 0) return 0;

  // Per-season PPG with reliability weighting — 7-game samples count less.
  const adjPpgs = qualifying.map(
    (s) => seasonPPG(s, format) * gameReliability(s.gamesPlayed),
  );

  // QBs stabilize slowly — a rookie or sophomore season is a noisy baseline.
  // Discount BPS for short track records so one hot year doesn't read the same
  // as a proven multi-year sample.
  const qbSmallSamplePenalty =
    position === "QB"
      ? qualifying.length === 1
        ? 0.85
        : qualifying.length === 2
        ? 0.92
        : 1.0
      : 1.0;

  // Missed-season penalty — if the player has no qualifying season in the
  // current year, their projection carries rust/injury risk. Applies across
  // positions.
  const missedCurrentSeasonPenalty =
    qualifying[0].season < CURRENT_SEASON ? 0.85 : 1.0;

  const basePenalty = qbSmallSamplePenalty * missedCurrentSeasonPenalty;

  if (qualifying.length === 1) return adjPpgs[0] * basePenalty;
  if (qualifying.length === 2)
    return (adjPpgs[0] * 0.6 + adjPpgs[1] * 0.4) * basePenalty;

  const [w0, w1, w2] = BPS_WEIGHTS[position];
  return (adjPpgs[0] * w0 + adjPpgs[1] * w1 + adjPpgs[2] * w2) * basePenalty;
}

export function weeklyCoefficientOfVariation(
  weekly: number[] | undefined,
): number | null {
  if (!weekly || weekly.length < 4) return null;
  const mean = weekly.reduce((a, b) => a + b, 0) / weekly.length;
  if (mean <= 0) return null;
  const variance =
    weekly.reduce((sum, x) => sum + (x - mean) ** 2, 0) / weekly.length;
  return Math.sqrt(variance) / mean;
}
