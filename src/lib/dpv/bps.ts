import { BPS_WEIGHTS, PPG_SCORING } from "./constants";
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
  const qualifying = seasons
    .filter((s) => s.gamesPlayed >= 7)
    .sort((a, b) => b.season - a.season)
    .slice(0, 3);

  if (qualifying.length === 0) return 0;

  const ppgs = qualifying.map((s) => seasonPPG(s, format));

  if (qualifying.length === 1) return ppgs[0];
  if (qualifying.length === 2) return ppgs[0] * 0.6 + ppgs[1] * 0.4;

  const [w0, w1, w2] = BPS_WEIGHTS[position];
  return ppgs[0] * w0 + ppgs[1] * w1 + ppgs[2] * w2;
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
