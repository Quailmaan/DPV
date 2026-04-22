import {
  PICK_CURVE,
  currentPickWindow,
  pickDpv,
} from "./constants";
import type { TradePlayer } from "@/app/trade/TradeCalculator";

// Generate all tradeable picks across the current 3-year rolling window as
// TradePlayer-compatible entries. IDs are synthetic (pick:YEAR:R.SS) so they
// never collide with NFL player IDs.
//
// classOverrides: per-year multiplier map supplied by the caller (typically
// the trade page, which reads class_strength from Supabase). Overrides the
// static CLASS_STRENGTH values when present.
export function generatePickPlayers(
  now: Date = new Date(),
  classOverrides?: Record<number, number>,
): TradePlayer[] {
  const [y0, y1, y2] = currentPickWindow(now);
  const years = [y0, y1, y2];
  const out: TradePlayer[] = [];
  const slots = Object.keys(PICK_CURVE);

  for (const year of years) {
    const classMult = classOverrides?.[year] ?? 1.0;
    const classSuffix =
      classMult > 1.02
        ? " • strong class"
        : classMult < 0.98
          ? " • weak class"
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
        tier: `${baseTier}${classSuffix}`,
      });
    }
  }

  // Sort by DPV descending so the highest-value picks surface first in search.
  out.sort((a, b) => b.dpv - a.dpv);
  return out;
}
