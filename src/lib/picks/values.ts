import {
  BASELINE_R1_OFFENSE_COUNT,
  PICK_CURVE,
  currentPickWindow,
  pickDpv,
  type ClassStrengthInput,
} from "./constants";
import type { TradePlayer } from "@/app/trade/TradeCalculator";

// Generate all tradeable picks across the current 3-year rolling window as
// TradePlayer-compatible entries. IDs are synthetic (pick:YEAR:R.SS) so they
// never collide with NFL player IDs.
//
// classOverrides: per-year depth signal supplied by the caller (the trade
// page, which reads class_strength from Supabase). Missing years default to
// neutral — picks still render before prospect data exists.
export function generatePickPlayers(
  now: Date = new Date(),
  classOverrides?: Record<number, ClassStrengthInput>,
): TradePlayer[] {
  const [y0, y1, y2] = currentPickWindow(now);
  const years = [y0, y1, y2];
  const out: TradePlayer[] = [];
  const slots = Object.keys(PICK_CURVE);

  for (const year of years) {
    const cs = classOverrides?.[year];
    const r1 = cs?.r1_offensive_count;
    const classSuffix =
      r1 === null || r1 === undefined
        ? ""
        : r1 >= BASELINE_R1_OFFENSE_COUNT + 2
          ? " • deep class"
          : r1 <= BASELINE_R1_OFFENSE_COUNT - 2
            ? " • shallow class"
            : "";
    for (const key of slots) {
      const [roundStr, slotStr] = key.split(".");
      const round = Number(roundStr) as 1 | 2 | 3;
      const slot = Number(slotStr);
      const dpv = pickDpv(year, round, slot, y0, classOverrides);
      if (dpv <= 0) continue;
      const baseTier =
        round === 1 ? (slot <= 4 ? "Early 1st" : slot <= 8 ? "Mid 1st" : "Late 1st")
        : round === 2 ? "2nd"
        : "3rd";
      out.push({
        id: `pick:${year}:${key}`,
        name: `${year} Pick ${key}`,
        position: "PICK",
        team: String(year),
        age: null,
        dpv,
        // Sub-option C: assume market broadly agrees with our pick model.
        // Picks therefore contribute equally to both the DPV and Market axes
        // and never trigger a Buy/Sell flag on the trade calculator.
        market: dpv,
        hasMarket: false,
        marketDelta: null,
        tier: `${baseTier}${classSuffix}`,
      });
    }
  }

  // Sort by DPV descending so the highest-value picks surface first in search.
  out.sort((a, b) => b.dpv - a.dpv);
  return out;
}

// Round-level pick value, averaged across all 12 slots. Used when we know
// the team owns "their R1" but not which slot inside the round (Sleeper's
// traded_picks endpoint only exposes round granularity until standings
// finalize).
function roundAverageDpv(
  year: number,
  round: 1 | 2 | 3,
  windowBase: number,
  classOverrides?: Record<number, ClassStrengthInput>,
): number {
  let sum = 0;
  let n = 0;
  for (let slot = 1; slot <= 12; slot++) {
    const v = pickDpv(year, round, slot, windowBase, classOverrides);
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? Math.round(sum / n) : 0;
}

export type LeaguePickRow = {
  season: number;
  round: number;
  original_roster_id: number;
  owner_roster_id: number;
};

export type RosterLabel = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
};

// Generate league-aware pick entries from synced league_picks rows. One
// TradePlayer per (year, round, original_roster_id) — i.e., per pick that
// could be on someone's roster. ownerRosterId reflects the current holder
// after trades.
//
// Names include the origin team when a pick has been traded ("2026 R1 from
// Falcons") so users can disambiguate between picks they own. Untraded
// picks (origin === owner) drop the suffix.
//
// IDs include the league_id to prevent cross-league collisions in the
// shared player index, and the original roster to keep picks unique within
// a round.
export function generateTeamRoundPicks(
  leagueId: string,
  picks: LeaguePickRow[],
  rosters: RosterLabel[],
  now: Date = new Date(),
  classOverrides?: Record<number, ClassStrengthInput>,
): TradePlayer[] {
  const [y0, y1, y2] = currentPickWindow(now);
  const seasonsInWindow = new Set([y0, y1, y2]);
  const rosterById = new Map<number, RosterLabel>();
  for (const r of rosters) rosterById.set(r.rosterId, r);

  const out: TradePlayer[] = [];
  for (const p of picks) {
    if (!seasonsInWindow.has(p.season)) continue;
    if (p.round < 1 || p.round > 3) continue;
    const round = p.round as 1 | 2 | 3;
    const dpv = roundAverageDpv(p.season, round, y0, classOverrides);
    if (dpv <= 0) continue;

    const cs = classOverrides?.[p.season];
    const r1 = cs?.r1_offensive_count;
    const classSuffix =
      r1 === null || r1 === undefined
        ? ""
        : r1 >= BASELINE_R1_OFFENSE_COUNT + 2
          ? " • deep class"
          : r1 <= BASELINE_R1_OFFENSE_COUNT - 2
            ? " • shallow class"
            : "";

    const orig = rosterById.get(p.original_roster_id);
    const traded = p.original_roster_id !== p.owner_roster_id;
    const originLabel =
      orig?.teamName?.trim() ||
      orig?.ownerName?.trim() ||
      `Roster ${p.original_roster_id}`;
    const baseName = `${p.season} R${round}`;
    const name = traded ? `${baseName} (from ${originLabel})` : baseName;
    const baseTier = round === 1 ? "1st" : round === 2 ? "2nd" : "3rd";

    out.push({
      id: `pick:${leagueId}:${p.season}:R${round}:from${p.original_roster_id}`,
      name,
      position: "PICK",
      team: String(p.season),
      age: null,
      dpv,
      market: dpv,
      hasMarket: false,
      marketDelta: null,
      tier: `${baseTier}${classSuffix}`,
      ownerRosterId: p.owner_roster_id,
    });
  }

  out.sort((a, b) => b.dpv - a.dpv);
  return out;
}
