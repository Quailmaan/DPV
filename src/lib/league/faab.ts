// Suggested FAAB bid for a free agent, out of a $100/season budget.
//
// Replacement-value (VORP-style) model:
//   1. Replacement level per position = the PYV of the last *startable*
//      player at that position, derived from league size × starter slots.
//      Below that line a player isn't a startable asset, so a FA there
//      warrants little/no FAAB regardless of raw PYV.
//   2. A FA's bid scales with how far its PYV sits ABOVE replacement.
//      ~0.85× replacement or below → depth ($0). At replacement →
//      marginal starter (small bid). ~1.45×+ → a league-altering add
//      that somehow hit waivers ($MAX).
//   3. An optional roster-need multiplier nudges the bid by the focused
//      team's strength at that position: weak → bid up, stacked → down.
//
// The result is a *value ceiling* ("what this player is worth to your
// roster"), not a market-price prediction — we can't know how aggressive
// your leaguemates are. The user allocates against their remaining budget.

export type FaabPosition = "QB" | "RB" | "WR" | "TE";

// Most a single player should ever be suggested at — half the season
// budget. A true league-winner can justify it; everything else lands
// well below.
const MAX_BID = 50;

// Effective league-wide starters per position from Sleeper roster_positions.
// Dedicated slots count fully; FLEX / SUPER_FLEX distribute across eligible
// positions by typical real-world usage so replacement level reflects
// actual start-ability demand, not just the dedicated slot count.
export function effectiveStarters(
  rosterPositions: string[] | null | undefined,
  totalRosters: number,
): Record<FaabPosition, number> {
  const perTeam: Record<FaabPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  // Fallback to a standard 1QB/2RB/2WR/1TE/1FLEX build when the league
  // hasn't synced roster_positions yet.
  const slots =
    rosterPositions && rosterPositions.length > 0
      ? rosterPositions
      : ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX"];
  for (const raw of slots) {
    const s = String(raw).toUpperCase();
    if (s === "QB") perTeam.QB += 1;
    else if (s === "RB") perTeam.RB += 1;
    else if (s === "WR") perTeam.WR += 1;
    else if (s === "TE") perTeam.TE += 1;
    else if (
      s === "FLEX" ||
      s === "WRRB_FLEX" ||
      s === "REC_FLEX" ||
      s === "WRRBTE_FLEX" ||
      s === "WRRB_WRT"
    ) {
      // RB/WR/TE flex — weighted to how flex spots are actually used.
      perTeam.RB += 0.45;
      perTeam.WR += 0.45;
      perTeam.TE += 0.1;
    } else if (s === "SUPER_FLEX" || s === "SUPERFLEX" || s === "QB_FLEX") {
      // SF spot is overwhelmingly a second QB.
      perTeam.QB += 0.75;
      perTeam.RB += 0.08;
      perTeam.WR += 0.12;
      perTeam.TE += 0.05;
    }
    // BN / IR / TAXI / K / DEF / DL etc. → not a startable skill slot.
  }
  return {
    QB: perTeam.QB * totalRosters,
    RB: perTeam.RB * totalRosters,
    WR: perTeam.WR * totalRosters,
    TE: perTeam.TE * totalRosters,
  };
}

// Replacement level PYV per position. pyvByPosition holds every ranked
// player's PYV at each position, sorted descending (rostered + FA). The
// replacement player is the (starters + buffer)-th best — the first guy
// who realistically wouldn't crack a starting lineup league-wide. The
// buffer accounts for bye-week / injury streaming demand.
export function replacementLevels(
  pyvByPosition: Record<FaabPosition, number[]>,
  starters: Record<FaabPosition, number>,
  buffer = 3,
): Record<FaabPosition, number> {
  const out: Record<FaabPosition, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
  for (const pos of ["QB", "RB", "WR", "TE"] as FaabPosition[]) {
    const arr = pyvByPosition[pos];
    if (!arr || arr.length === 0) continue;
    const rank = Math.max(1, Math.round(starters[pos]) + buffer);
    const idx = Math.min(arr.length - 1, rank - 1);
    out[pos] = arr[idx] ?? 0;
  }
  return out;
}

// Roster-need multiplier from the focused team's total PYV at a position
// vs the league per-team average. Weak (below avg) → bid up to +40%;
// stacked (above avg) → down to −30%. Pass equal values (or use 1.0
// directly) for the unfocused power-rankings view.
export function needMultiplier(
  teamPosPyv: number,
  leagueAvgPosPyv: number,
): number {
  if (leagueAvgPosPyv <= 0) return 1.0;
  const ratio = teamPosPyv / leagueAvgPosPyv;
  const m = 1.0 + (1.0 - ratio) * 0.5; // ratio 0.6→1.2, 1.4→0.8
  return Math.max(0.7, Math.min(1.4, m));
}

// Final suggested bid (integer dollars, 0-MAX_BID). Returns 0 for
// below-replacement depth, and floors any startable-tier FA at $1 so a
// "worth a token flier" player never silently rounds to nothing.
export function suggestFaab(
  faPyv: number,
  position: FaabPosition,
  replacement: Record<FaabPosition, number>,
  need = 1.0,
): number {
  const repl = replacement[position];
  if (repl <= 0) return 0;
  const ratio = faPyv / repl;
  const shaped = Math.max(0, Math.min(1, (ratio - 0.85) / 0.6));
  if (shaped <= 0) return 0;
  const bid = Math.round(MAX_BID * shaped * need);
  return Math.max(1, Math.min(MAX_BID, bid));
}
