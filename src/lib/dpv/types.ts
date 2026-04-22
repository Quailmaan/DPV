export type Position = "QB" | "RB" | "WR" | "TE";

export type ScoringFormat = "STANDARD" | "HALF_PPR" | "FULL_PPR";

export type QBTier = 1 | 2 | 3 | 4 | 5;

export type QBTransition =
  | "STABLE"
  | "KNOWN_UPGRADE"
  | "LATERAL"
  | "KNOWN_DOWNGRADE"
  | "UNKNOWN_ROOKIE";

export type ContractStatus = "UNDER_CONTRACT" | "CONTRACT_YEAR" | "EXPIRING";

export interface SeasonStats {
  season: number;
  gamesPlayed: number;
  passingYards: number;
  passingTDs: number;
  interceptions: number;
  rushingYards: number;
  rushingTDs: number;
  receptions: number;
  receivingYards: number;
  receivingTDs: number;
  fumblesLost: number;
  weeklyFantasyPoints?: number[];
}

export interface OpportunityInputs {
  snapSharePct: number;
  targetSharePct?: number;
  opportunitySharePct?: number;
  teamVacatedTargetPct?: number;
  projectedAbsorptionRate?: number;
}

export interface SituationInputs {
  teamOLineCompositeRank: number;
  qbTier: QBTier;
  qbTierPrevious?: QBTier;
  qbTransition?: QBTransition;
}

export interface PlayerProfile {
  playerId: string;
  name: string;
  position: Position;
  age: number;
  nflDraftRound?: number;
  contractStatus?: ContractStatus;
  teamOffenseRank?: number;
}

export interface PrecomputedHSM {
  meanNextPPG: number | null;
  medianNextPPG: number | null;
  n: number;
}

export interface DPVInput {
  profile: PlayerProfile;
  seasons: SeasonStats[];
  opportunity: OpportunityInputs;
  situation: SituationInputs;
  scoringFormat: ScoringFormat;
  marketValueNormalized?: number;
  positionRank?: number;
  precomputedHSM?: PrecomputedHSM;
}

export interface DPVBreakdown {
  bps: number;
  ageModifier: number;
  opportunityScore: number;
  olineModifier: number;
  qbQualityModifier: number;
  bbcsModifier: number;
  scoringFormatWeight: number;
  scarcityMultiplier: number;
  dpvRaw: number;
  dpvProjected: number;
  dpvFinal: number;
  dpvNormalized: number;
  hsmConfidence: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  hsmBlendWeight: number;
  marketBlendWeight: number;
}

export interface DPVResult {
  playerId: string;
  name: string;
  position: Position;
  age: number;
  dpv: number;
  tier: string;
  breakdown: DPVBreakdown;
}
