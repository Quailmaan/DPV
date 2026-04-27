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
