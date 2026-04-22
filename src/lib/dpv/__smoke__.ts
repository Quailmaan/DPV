import { calculateDPV } from "./dpv";
import type { DPVInput } from "./types";

const jaMarrChase: DPVInput = {
  profile: {
    playerId: "chase-jamarr",
    name: "Ja'Marr Chase",
    position: "WR",
    age: 24,
    nflDraftRound: 1,
    contractStatus: "UNDER_CONTRACT",
    teamOffenseRank: 8,
  },
  seasons: [
    {
      season: 2024,
      gamesPlayed: 17,
      passingYards: 0,
      passingTDs: 0,
      interceptions: 0,
      rushingYards: 32,
      rushingTDs: 0,
      receptions: 127,
      receivingYards: 1708,
      receivingTDs: 17,
      fumblesLost: 1,
    },
    {
      season: 2023,
      gamesPlayed: 16,
      passingYards: 0,
      passingTDs: 0,
      interceptions: 0,
      rushingYards: 16,
      rushingTDs: 0,
      receptions: 100,
      receivingYards: 1216,
      receivingTDs: 7,
      fumblesLost: 0,
    },
    {
      season: 2022,
      gamesPlayed: 12,
      passingYards: 0,
      passingTDs: 0,
      interceptions: 0,
      rushingYards: 23,
      rushingTDs: 0,
      receptions: 87,
      receivingYards: 1046,
      receivingTDs: 9,
      fumblesLost: 0,
    },
  ],
  opportunity: {
    snapSharePct: 92,
    targetSharePct: 30,
    teamVacatedTargetPct: 0,
    projectedAbsorptionRate: 0,
  },
  situation: {
    teamOLineCompositeRank: 20,
    qbTier: 2,
    qbTierPrevious: 2,
    qbTransition: "STABLE",
  },
  scoringFormat: "HALF_PPR",
  positionRank: 1,
};

const bijanRobinson: DPVInput = {
  profile: {
    playerId: "robinson-bijan",
    name: "Bijan Robinson",
    position: "RB",
    age: 24,
    nflDraftRound: 1,
    contractStatus: "UNDER_CONTRACT",
  },
  seasons: [
    {
      season: 2024,
      gamesPlayed: 17,
      passingYards: 0,
      passingTDs: 0,
      interceptions: 0,
      rushingYards: 1456,
      rushingTDs: 14,
      receptions: 61,
      receivingYards: 431,
      receivingTDs: 1,
      fumblesLost: 1,
    },
    {
      season: 2023,
      gamesPlayed: 17,
      passingYards: 0,
      passingTDs: 0,
      interceptions: 0,
      rushingYards: 976,
      rushingTDs: 4,
      receptions: 58,
      receivingYards: 487,
      receivingTDs: 4,
      fumblesLost: 1,
    },
  ],
  opportunity: {
    snapSharePct: 78,
    opportunitySharePct: 68,
    teamVacatedTargetPct: 0,
    projectedAbsorptionRate: 0,
  },
  situation: {
    teamOLineCompositeRank: 12,
    qbTier: 3,
    qbTierPrevious: 3,
    qbTransition: "STABLE",
  },
  scoringFormat: "HALF_PPR",
  positionRank: 1,
};

function dump(label: string, r: ReturnType<typeof calculateDPV>) {
  console.log(`--- ${label} ---`);
  console.log(`DPV: ${r.dpv}  Tier: ${r.tier}`);
  console.log(`  BPS: ${r.breakdown.bps.toFixed(2)}`);
  console.log(`  AM:  ${r.breakdown.ageModifier.toFixed(3)}`);
  console.log(`  OS:  ${r.breakdown.opportunityScore.toFixed(3)}`);
  console.log(`  OLQI: ${r.breakdown.olineModifier.toFixed(3)}`);
  console.log(`  QQS:  ${r.breakdown.qbQualityModifier.toFixed(3)}`);
  console.log(`  BBCS: ${r.breakdown.bbcsModifier.toFixed(3)}`);
  console.log(`  SFW:  ${r.breakdown.scoringFormatWeight.toFixed(3)}`);
  console.log(`  Scarcity: ${r.breakdown.scarcityMultiplier.toFixed(3)}`);
  console.log(`  raw: ${r.breakdown.dpvRaw.toFixed(2)}`);
  console.log(`  final: ${r.breakdown.dpvFinal.toFixed(2)}`);
}

dump("Chase (WR)", calculateDPV(jaMarrChase));
dump("Bijan (RB)", calculateDPV(bijanRobinson));
