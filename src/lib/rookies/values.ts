// Synthetic rookie tradeable entries — same pattern as src/lib/picks/values.ts.
//
// The trade calculator reads dpv_snapshots ⨝ players, but for the post-draft
// 1-3 day window before nflverse publishes draft_picks.csv there is no
// players row for fresh rookies and therefore no DPV snapshot. Without a
// stop-gap, rookies are unsearchable in trades for the period of the year
// when interest in them is highest.
//
// This module bridges the gap by generating TradePlayer entries directly
// from prospect_consensus + Sleeper team data. It reuses computeRookiePrior
// for the base math and overlays a consensus-grade tie-breaker so a
// grade-95 R1 prospect prices above a grade-78 R1 prospect.
//
// IDs are prefixed `rookie:<prospect_id>` so they never collide with
// gsis-keyed player_ids. Once nflverse publishes and compute-dpv emits a
// real rookie prior, the trade page should prefer the real entry — see
// merging logic in src/app/trade/page.tsx.

import type { TradePlayer } from "@/app/trade/TradeCalculator";
import {
  computeRookiePrior,
  rookiePriorTier,
} from "@/lib/dpv/rookie-prior";
import type { Position, QBTier, ScoringFormat } from "@/lib/dpv/types";

export type ProspectInput = {
  prospectId: string;
  name: string;
  position: string;
  /** 1-7 from cross-source consensus, or null if unranked. Used as the
   *  pre-publish proxy for the actual draft round. */
  projectedRound: number | null;
  /** Cross-source normalized 0-100, or null. Drives the tie-breaker overlay. */
  consensusGrade: number | null;
  /** Decimal years on Sept 1 of incoming class year, or null if unknown. */
  ageAtDraft: number | null;
  draftYear: number;
};

export type TeamContextInput = {
  /** 1 (best) … 32 (worst). */
  olineRank: number | null;
  /** 1 (best) … 5 (worst). */
  qbTier: number | null;
};

export type RookieValueInput = {
  prospect: ProspectInput;
  /** Sleeper-resolved team (nflverse-style abbrev), or null if undrafted/UDFA. */
  team: string | null;
  /** Most-recent team_seasons row for `team`, or null. Drives OL/QB context. */
  teamContext: TeamContextInput | null;
  scoringFormat: ScoringFormat;
};

// Consensus-grade overlay. Within a given round, top-of-class prospects
// project meaningfully better than late-of-class — the round bucket alone
// flattens that. Calibrated against typical incoming-class grade
// distributions: average ≈ 75, R1 elites ≈ 92-96, fringe Day-3 ≈ 55-65.
//
// Capped at ±15% so this stays a tie-breaker, not a redo of draft capital.
function consensusGradeMult(grade: number | null): number {
  if (grade === null) return 1.0;
  if (grade >= 95) return 1.12;
  if (grade >= 88) return 1.07;
  if (grade >= 80) return 1.03;
  if (grade >= 70) return 1.0;
  if (grade >= 60) return 0.96;
  if (grade >= 50) return 0.9;
  return 0.85;
}

const SUPPORTED: ReadonlySet<string> = new Set(["QB", "RB", "WR", "TE"]);

// Bucket a projected overall pick into a round, in case `projectedRound` is
// null but `projected_overall_pick` is set (some sources only publish picks).
export function roundFromOverallPick(pick: number | null): number | null {
  if (pick === null || pick === undefined) return null;
  if (pick <= 32) return 1;
  if (pick <= 64) return 2;
  if (pick <= 100) return 3;
  if (pick <= 138) return 4;
  if (pick <= 176) return 5;
  if (pick <= 220) return 6;
  if (pick <= 262) return 7;
  return null;
}

// Returns null if this prospect shouldn't render as a tradeable rookie
// (wrong position, no signal at all). The caller decides whether to surface
// no-team prospects — most leagues will only want to trade drafted rookies.
export function computeRookieTradeValue(
  input: RookieValueInput,
): TradePlayer | null {
  const pos = input.prospect.position?.toUpperCase();
  if (!pos || !SUPPORTED.has(pos)) return null;
  const position = pos as Position;

  const prior = computeRookiePrior({
    position,
    draftRound: input.prospect.projectedRound,
    ageAtDraft: input.prospect.ageAtDraft,
    teamOLineRank: input.teamContext?.olineRank ?? null,
    qbTier: (input.teamContext?.qbTier ?? null) as QBTier | null,
    scoringFormat: input.scoringFormat,
    missedSeasons: 0,
    maxGamesPlayed: 0,
    intraClassDepthIdx: 0,
    rookieDisplacementMult: 1.0,
    // Combine RAS lookup is keyed by gsis_id which fresh rookies don't have
    // yet. Skipped for synthetic values; once the real prior fires post-
    // publish, athleticism is layered in.
    athleticismScore: null,
    hsmProjectedPPG: null,
    hsmN: 0,
  });

  const gradeMult = consensusGradeMult(input.prospect.consensusGrade);
  const dpv = Math.round(prior.dpv * gradeMult);
  if (dpv <= 0) return null;

  const baseTier = rookiePriorTier(
    position,
    input.prospect.projectedRound,
    0,
  );
  // Annotate so users know the value is a pre-publish projection, not a
  // settled rookie prior. Drops once compute-dpv replaces it post-publish.
  const tier = `${baseTier} • proj`;

  return {
    id: `rookie:${input.prospect.prospectId}`,
    name: input.prospect.name,
    position,
    team: input.team,
    age:
      input.prospect.ageAtDraft !== null
        ? Number(input.prospect.ageAtDraft.toFixed(1))
        : null,
    dpv,
    // Sub-option C (mirrors picks): no FantasyCalc rookie market yet,
    // so market = dpv keeps trade-side sums sane and Buy/Sell badges stay
    // off until a real market value lands.
    market: dpv,
    hasMarket: false,
    marketDelta: null,
    tier,
  };
}

export function generateRookieTradeEntries(
  inputs: RookieValueInput[],
): TradePlayer[] {
  const out: TradePlayer[] = [];
  for (const i of inputs) {
    const v = computeRookieTradeValue(i);
    if (v) out.push(v);
  }
  out.sort((a, b) => b.dpv - a.dpv);
  return out;
}
