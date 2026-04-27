// League-aware position scarcity (VBD-style replacement cliff).
//
// Why this exists: a 9000-DPV RB and a 9000-DPV QB are not the same trade
// chip. In a 12-team 1-QB league there are ~16 startable QBs (12 starters +
// streamers) but only ~24 startable RBs against ~36 starting RB+FLEX slots.
// Every RB above the cliff is fighting for a starter spot every week; QBs
// above the cliff are mostly redundant. Raw DPV doesn't see that — VAR
// (value above replacement) does.
//
// Approach: for each position P, count the *expected number of starters at
// P across the whole league* (literal slots + a fractional share of FLEX /
// SUPER_FLEX). The replacement player is the player ranked exactly at that
// count — the last guy who'd be starting if every team played optimally.
// VAR_P(player) = max(0, dpv − replacement_dpv_P).
//
// This is the same math VBD uses for redraft, applied to dynasty DPV. It's
// purely position-level (not roster-shape aware) — that's a feature, not a
// bug. Trades happen between teams of varying construction; position-level
// scarcity is the league-wide constant that makes RB-for-QB swaps honest.

import type { Position } from "@/lib/dpv/types";

export type ReplacementByPosition = Record<Position, number>;

// FLEX slot shares — how a generic FLEX divvies up between RB/WR/TE in
// practice. Calibrated against typical PPR start-rate splits. RB-heavy
// because of touch volume, WR strong, TE rarely flexed.
const FLEX_SHARE: Record<Position, number> = {
  QB: 0,
  RB: 0.5,
  WR: 0.45,
  TE: 0.05,
};

// SUPER_FLEX is overwhelmingly QB — the entire reason the slot exists. The
// tiny non-QB share covers the handful of teams who streamline a stud
// skill player when their QB room is thin.
const SUPER_FLEX_SHARE: Record<Position, number> = {
  QB: 0.85,
  RB: 0.1,
  WR: 0.04,
  TE: 0.01,
};

// REC_FLEX (WR/TE only). Less common but real (e.g. some TE-premium leagues).
const REC_FLEX_SHARE: Record<Position, number> = {
  QB: 0,
  RB: 0,
  WR: 0.85,
  TE: 0.15,
};

// WR/RB only flex (no TE).
const WRRB_FLEX_SHARE: Record<Position, number> = {
  QB: 0,
  RB: 0.55,
  WR: 0.45,
  TE: 0,
};

const ZERO: ReplacementByPosition = { QB: 0, RB: 0, WR: 0, TE: 0 };

function addShare(
  acc: ReplacementByPosition,
  share: Record<Position, number>,
): ReplacementByPosition {
  return {
    QB: acc.QB + share.QB,
    RB: acc.RB + share.RB,
    WR: acc.WR + share.WR,
    TE: acc.TE + share.TE,
  };
}

// Standard 12-team 1-QB build used when no league is selected. Conservative
// default: 1 QB, 2 RB, 3 WR, 1 TE, 1 FLEX. Lines up with mainstream redraft
// roster construction and dynasty.com defaults.
const DEFAULT_PER_TEAM_DEMAND: ReplacementByPosition = addShare(
  { QB: 1, RB: 2, WR: 3, TE: 1 },
  FLEX_SHARE,
);

const DEFAULT_TEAM_COUNT = 12;

/**
 * Per-team starter demand from a Sleeper-style roster_positions array.
 * Bench / IR / DEF / K / IDP slots are ignored — they don't compete with
 * skill positions for a roster spot in the trade math.
 *
 * Returns expected starters per team (fractional, since flex shares split).
 */
export function perTeamStarterDemand(
  rosterPositions: readonly string[] | null | undefined,
): ReplacementByPosition {
  if (!rosterPositions || rosterPositions.length === 0) {
    return DEFAULT_PER_TEAM_DEMAND;
  }
  let demand: ReplacementByPosition = { ...ZERO };
  for (const raw of rosterPositions) {
    const slot = raw.toUpperCase();
    switch (slot) {
      case "QB":
        demand.QB += 1;
        break;
      case "RB":
        demand.RB += 1;
        break;
      case "WR":
        demand.WR += 1;
        break;
      case "TE":
        demand.TE += 1;
        break;
      case "FLEX":
      case "WR_RB_TE":
        demand = addShare(demand, FLEX_SHARE);
        break;
      case "SUPER_FLEX":
      case "QB_WR_RB_TE":
        demand = addShare(demand, SUPER_FLEX_SHARE);
        break;
      case "REC_FLEX":
      case "WR_TE":
        demand = addShare(demand, REC_FLEX_SHARE);
        break;
      case "WRRB_FLEX":
      case "WR_RB":
        demand = addShare(demand, WRRB_FLEX_SHARE);
        break;
      // BN, IR, TAXI, K, DEF, DL, LB, DB, IDP_FLEX — irrelevant for skill
      // scarcity. Ignored on purpose.
      default:
        break;
    }
  }
  return demand;
}

/**
 * Replacement DPV per position. Pull every player at each position, sort
 * descending by DPV, and read the value at index = round(teams × demand_P).
 * That's the player who is JUST barely a startable asset — anyone below
 * them is roster filler, anyone above is competing for a real starter spot.
 */
export function computeReplacementDPV(
  players: ReadonlyArray<{ position: string; dpv: number }>,
  perTeamDemand: ReplacementByPosition,
  teamCount: number,
): ReplacementByPosition {
  const out: ReplacementByPosition = { ...ZERO };
  for (const pos of ["QB", "RB", "WR", "TE"] as const) {
    const ranked = players
      .filter((p) => p.position === pos)
      .map((p) => p.dpv)
      .sort((a, b) => b - a);
    if (ranked.length === 0) continue;
    const cliffIdx = Math.max(
      0,
      Math.min(
        ranked.length - 1,
        Math.round(perTeamDemand[pos] * teamCount) - 1,
      ),
    );
    out[pos] = ranked[cliffIdx];
  }
  return out;
}

/**
 * Convenience wrapper: given roster_positions (or null) + total_rosters
 * (or null), produce the replacement-DPV map directly. Falls back to the
 * standard 12-team 1-QB construction when the league is unspecified.
 *
 * The `replacementCushion` knob (default 1.0) lets callers slightly inflate
 * or deflate the cliff. Most callers should leave it at 1.
 */
export function leagueReplacementDPV(
  players: ReadonlyArray<{ position: string; dpv: number }>,
  rosterPositions: readonly string[] | null | undefined,
  totalRosters: number | null | undefined,
  replacementCushion = 1.0,
): { replacement: ReplacementByPosition; teamCount: number; isDefault: boolean } {
  const isDefault = !rosterPositions || rosterPositions.length === 0;
  const perTeam = perTeamStarterDemand(rosterPositions);
  const teamCount =
    typeof totalRosters === "number" && totalRosters > 0
      ? totalRosters
      : DEFAULT_TEAM_COUNT;
  const raw = computeReplacementDPV(players, perTeam, teamCount);
  const replacement: ReplacementByPosition = {
    QB: Math.round(raw.QB * replacementCushion),
    RB: Math.round(raw.RB * replacementCushion),
    WR: Math.round(raw.WR * replacementCushion),
    TE: Math.round(raw.TE * replacementCushion),
  };
  return { replacement, teamCount, isDefault };
}

/**
 * Detect a Superflex / 2-QB league from its roster_positions. Used to flip
 * the rookie-prior QB scaling without making the caller hand-classify the
 * league. Counts SUPER_FLEX (or QB_WR_RB_TE) and dedicated extra QB slots
 * — anything with >1 expected starting QB per team is Superflex-equivalent
 * for QB scarcity purposes.
 */
export function isSuperflexConstruction(
  rosterPositions: readonly string[] | null | undefined,
): boolean {
  if (!rosterPositions || rosterPositions.length === 0) return false;
  let qbStarters = 0;
  for (const raw of rosterPositions) {
    const slot = raw.toUpperCase();
    if (slot === "QB") qbStarters += 1;
    else if (slot === "SUPER_FLEX" || slot === "QB_WR_RB_TE") qbStarters += 1;
  }
  return qbStarters >= 2;
}

/** VAR = value above replacement. Negative-clamped — a deep-bench player
 *  contributes 0 to a side's VAR sum, not negative. */
export function valueAboveReplacement(
  position: string,
  dpv: number,
  replacement: ReplacementByPosition,
): number {
  const repl =
    position === "QB" || position === "RB" || position === "WR" || position === "TE"
      ? replacement[position as Position]
      : 0;
  return Math.max(0, dpv - repl);
}
