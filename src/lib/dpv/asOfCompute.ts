// As-of-season DPV compute. Used by scripts/backfill-historical-dpv.ts
// to populate dpv_history with one snapshot per (player × past season).
//
// The day-to-day compute lives in scripts/compute-dpv.ts and uses
// "current" data for every input (current depth chart, current age,
// current team_seasons row). For the trend chart's career-arc view we
// need the inverse: "what would the model have said at the END of
// season S, given only data available through S?"
//
// Design note: this is deliberately NOT a refactor of the daily
// compute. The daily script is 1000 lines of nuanced production logic;
// threading an `as_of` parameter through every internal helper would be
// risky for marginal benefit. Instead we build a parallel, simplified
// pass that:
//   • Reuses the pure calculateDPV engine (same scoring math)
//   • Uses (player_seasons, team_seasons) snapshots from season S
//   • Skips inputs that don't make sense for past seasons:
//       - rookieDisplacement (forward-looking; resolved for past S)
//       - HSM / market blend (no historical comp tables / market data)
//       - QB depth chart (would need historical roster reconstruction)
//   • Keeps inputs that do:
//       - BPS from latest 3 qualifying seasons ≤ S
//       - Age at start of S+1 (forward-looking, matches daily semantics)
//       - Opportunity from season S (with disruption blend)
//       - O-line + QB tier from team_seasons[player_team_in_S | S]
//       - Position rank + scarcity, computed within the as-of cohort
//
// Validation: run the backfill, spot-check a few reference players
// (an established alpha, a journeyman who switched teams, a rookie's
// first qualifying year). DPVs should track the player's actual
// fantasy outcome that year — Amon-Ra 2024 should be elite, CMC 2020
// (3g injury year) should be skipped (no qualifying season), CMC 2023
// should be elite, etc.

import { calculateDPV } from "./dpv";
import type {
  DPVInput,
  DPVResult,
  Position,
  QBTier,
  ScoringFormat,
  SeasonStats,
} from "./types";

/** A row from `player_seasons`. The shape mirrors what compute-dpv.ts
 *  loads — kept as a separate type so the backfill script can pass
 *  data in without coupling to that script's internals. */
export type PlayerSeasonRow = {
  player_id: string;
  season: number;
  team: string | null;
  games_played: number;
  passing_yards: number | null;
  passing_tds: number | null;
  interceptions: number | null;
  rushing_yards: number | null;
  rushing_tds: number | null;
  receptions: number | null;
  receiving_yards: number | null;
  receiving_tds: number | null;
  fumbles_lost: number | null;
  snap_share_pct: number | null;
  target_share_pct: number | null;
  opportunity_share_pct: number | null;
  weekly_fantasy_points_half: number[] | null;
};

export type TeamSeasonRow = {
  team: string;
  season: number;
  oline_composite_rank: number | null;
  qb_tier: number | null;
};

export type PlayerProfileRow = {
  player_id: string;
  name: string;
  position: string;
  birthdate: string | null;
};

export type AsOfDpvOutput = {
  player_id: string;
  scoring_format: ScoringFormat;
  season: number;
  /** Same DPV scale as the live snapshot (0-10000). */
  dpv: number;
  /** Same tier labels as the live snapshot. */
  tier: string;
  /** Full breakdown so the "what changed" panel can compare against
   *  the live snapshot if the user looks at, e.g., 2024 → 2025. */
  breakdown: DPVResult["breakdown"];
};

/** Convert a player_seasons row to the SeasonStats shape calculateDPV
 *  expects. Identical to compute-dpv's helper — duplicated here so this
 *  module has no dependency on the script. */
function toSeasonStats(row: PlayerSeasonRow): SeasonStats {
  return {
    season: row.season,
    gamesPlayed: row.games_played ?? 0,
    passingYards: row.passing_yards ?? 0,
    passingTDs: row.passing_tds ?? 0,
    interceptions: row.interceptions ?? 0,
    rushingYards: row.rushing_yards ?? 0,
    rushingTDs: row.rushing_tds ?? 0,
    receptions: row.receptions ?? 0,
    receivingYards: row.receiving_yards ?? 0,
    receivingTDs: row.receiving_tds ?? 0,
    fumblesLost: row.fumbles_lost ?? 0,
    weeklyFantasyPoints: row.weekly_fantasy_points_half ?? undefined,
  };
}

// Player's age at the start of a given season's free-agency window
// (March 1 of that season's year). The daily compute uses "now" — the
// equivalent at as-of S is "what age were they when teams were making
// decisions about season S?" Using March 1 lines up with the offseason
// signing period that drives most depth-chart inputs.
function ageAtSeasonStart(birthdate: string, season: number): number {
  const bd = new Date(birthdate);
  const seasonStart = new Date(`${season}-03-01T00:00:00Z`);
  return (
    (seasonStart.getTime() - bd.getTime()) / (365.25 * 24 * 3600 * 1000)
  );
}

// Same disrupted-season opportunity blend the daily compute uses, but
// anchored to `targetSeason` instead of CURRENT_SEASON. When the player
// has 3+ qualifying seasons in [targetSeason-3, targetSeason] AND their
// season-S row was a low-game year (<14g), blend across the qualifying
// window instead of using S in isolation. Stops a lone injury year from
// crashing a healthy player's historical DPV.
function buildOpportunityInputs(
  qualifyingThroughS: ReadonlyArray<PlayerSeasonRow>,
  targetSeasonRow: PlayerSeasonRow,
  targetSeason: number,
): DPVInput["opportunity"] {
  const lookback = qualifyingThroughS
    .filter((s) => s.season >= targetSeason - 3 && s.season <= targetSeason)
    .slice(0, 3);
  const useBlend =
    lookback.length >= 3 && (targetSeasonRow.games_played ?? 0) < 14;

  if (!useBlend) {
    return {
      snapSharePct: targetSeasonRow.snap_share_pct ?? 0,
      targetSharePct: targetSeasonRow.target_share_pct ?? undefined,
      opportunitySharePct: targetSeasonRow.opportunity_share_pct ?? undefined,
      teamVacatedTargetPct: 0,
      projectedAbsorptionRate: 0,
    };
  }

  let snapSum = 0,
    snapGames = 0,
    targetSum = 0,
    targetGames = 0,
    oppSum = 0,
    oppGames = 0;
  for (const s of lookback) {
    const g = s.games_played ?? 0;
    if (g <= 0) continue;
    if (s.snap_share_pct !== null) {
      snapSum += s.snap_share_pct * g;
      snapGames += g;
    }
    if (s.target_share_pct !== null) {
      targetSum += s.target_share_pct * g;
      targetGames += g;
    }
    if (s.opportunity_share_pct !== null) {
      oppSum += s.opportunity_share_pct * g;
      oppGames += g;
    }
  }
  return {
    snapSharePct:
      snapGames > 0 ? snapSum / snapGames : targetSeasonRow.snap_share_pct ?? 0,
    targetSharePct:
      targetGames > 0
        ? targetSum / targetGames
        : targetSeasonRow.target_share_pct ?? undefined,
    opportunitySharePct:
      oppGames > 0
        ? oppSum / oppGames
        : targetSeasonRow.opportunity_share_pct ?? undefined,
    teamVacatedTargetPct: 0,
    projectedAbsorptionRate: 0,
  };
}

/**
 * Compute every player's DPV for a single past season `targetSeason`,
 * using only data that existed through that season. Output rows are
 * grouped by scoring format and ranked within position with scarcity
 * applied (matching the live compute's two-pass approach).
 *
 * Returns one row per (player, scoring_format) where the player has a
 * qualifying (≥7g) season AT `targetSeason`. Players who didn't play
 * that year — or whose only games that year were a sub-7-game injury
 * cameo — are silently skipped: there's no defensible DPV to assign.
 */
export function computeDpvAsOfSeason(args: {
  targetSeason: number;
  players: ReadonlyArray<PlayerProfileRow>;
  /** All player_seasons rows. Will be filtered internally per player. */
  playerSeasons: ReadonlyArray<PlayerSeasonRow>;
  /** All team_seasons rows. Indexed internally by `${team}|${season}`. */
  teamSeasons: ReadonlyArray<TeamSeasonRow>;
  /** Default ['STANDARD','HALF_PPR','FULL_PPR']. Override for testing. */
  formats?: ReadonlyArray<ScoringFormat>;
}): AsOfDpvOutput[] {
  const { targetSeason, players, playerSeasons, teamSeasons } = args;
  const formats: ReadonlyArray<ScoringFormat> = args.formats ?? [
    "STANDARD",
    "HALF_PPR",
    "FULL_PPR",
  ];

  const teamIdx = new Map<string, TeamSeasonRow>();
  for (const t of teamSeasons) {
    teamIdx.set(`${t.team}|${t.season}`, t);
  }

  // Group player_seasons by player_id once.
  const byPlayer = new Map<string, PlayerSeasonRow[]>();
  for (const s of playerSeasons) {
    const arr = byPlayer.get(s.player_id) ?? [];
    arr.push(s);
    byPlayer.set(s.player_id, arr);
  }

  type Prelim = {
    playerId: string;
    position: Position;
    input: DPVInput;
    preDPV: number;
  };
  const prelim: Record<ScoringFormat, Prelim[]> = {
    STANDARD: [],
    HALF_PPR: [],
    FULL_PPR: [],
  };

  for (const p of players) {
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
    if (!p.birthdate) continue;

    const all = byPlayer.get(p.player_id) ?? [];
    // Qualifying seasons up through targetSeason, descending.
    const qualifyingThroughS = all
      .filter((s) => s.season <= targetSeason && s.games_played >= 7)
      .sort((a, b) => b.season - a.season);

    // Need a qualifying season AT targetSeason itself for a meaningful
    // backfill point — otherwise the player either didn't play that year
    // or was on a sub-7g injury stretch and assigning them a DPV would
    // mean projecting forward without their actual season. Skip.
    const seasonRow = qualifyingThroughS.find(
      (s) => s.season === targetSeason,
    );
    if (!seasonRow) continue;

    // Feed the latest 3 qualifying seasons ≤ S into BPS — same window
    // shape the daily compute uses, just rooted at S instead of CURRENT_SEASON.
    const seasonStats = qualifyingThroughS.slice(0, 3).map(toSeasonStats);

    // Team context: the team this player was on IN season S, looking up
    // that team's row in team_seasons[team|S]. Falls back to a neutral
    // mid-pack row if either is missing (rare — every team_seasons year
    // is fully populated 2013-2025 in our DB).
    const teamForS = seasonRow.team;
    const teamCtx = teamForS ? teamIdx.get(`${teamForS}|${targetSeason}`) : null;
    const olineRank = teamCtx?.oline_composite_rank ?? 16;
    const qbTier = (teamCtx?.qb_tier ?? 3) as QBTier;

    const age = ageAtSeasonStart(p.birthdate, targetSeason);

    for (const fmt of formats) {
      const input: DPVInput = {
        profile: {
          playerId: p.player_id,
          name: p.name,
          position: p.position as Position,
          age,
        },
        seasons: seasonStats,
        opportunity: buildOpportunityInputs(
          qualifyingThroughS,
          seasonRow,
          targetSeason,
        ),
        situation: {
          teamOLineCompositeRank: olineRank,
          qbTier,
          qbTierPrevious: qbTier,
          qbTransition: "STABLE",
        },
        scoringFormat: fmt,
        // Anchor BPS recency to the target season — without this, the
        // hard-coded CURRENT_SEASON-3 window in calculateBPS makes every
        // pre-2022 backfill row return DPV=0 (no qualifying seasons in
        // the [CURRENT_SEASON-3, CURRENT_SEASON] window).
        asOfSeason: targetSeason,
        // Skipped for as-of: rookieDisplacementMult (forward-looking),
        // qbStarterRateMult / qbDepthChartMult (would need historical
        // roster reconstruction; daily compute uses 2-yr lookback off
        // current_team which doesn't exist for past seasons),
        // precomputedHSM (no historical hsm_comps tables),
        // marketValueNormalized (no historical market data).
        // calculateDPV defaults the multipliers to 1.0 and the HSM/
        // market blends to "no contribution," which is the correct
        // graceful degradation here.
      };

      const r = calculateDPV(input);
      prelim[fmt].push({
        playerId: p.player_id,
        position: p.position as Position,
        input,
        preDPV: r.dpv,
      });
    }
  }

  // Second pass: rank within position, recompute with positionRank so
  // scarcity multiplier kicks in. Same shape as the daily compute.
  const out: AsOfDpvOutput[] = [];
  for (const fmt of formats) {
    const byPos = new Map<Position, Prelim[]>();
    for (const e of prelim[fmt]) {
      const arr = byPos.get(e.position) ?? [];
      arr.push(e);
      byPos.set(e.position, arr);
    }
    for (const arr of byPos.values()) {
      arr.sort((a, b) => b.preDPV - a.preDPV);
      arr.forEach((entry, i) => {
        const positionRank = i + 1;
        const final = calculateDPV({ ...entry.input, positionRank });
        out.push({
          player_id: entry.playerId,
          scoring_format: fmt,
          season: targetSeason,
          dpv: final.dpv,
          tier: final.tier,
          breakdown: final.breakdown,
        });
      });
    }
  }

  return out;
}
