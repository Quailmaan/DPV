import {
  PICK_CURVE,
  currentPickWindow,
  pickDpv,
} from "./constants";
import type { TradePlayer } from "@/app/trade/TradeCalculator";

// Generate all tradeable picks across the current 3-year rolling window as
// TradePlayer-compatible entries. IDs are synthetic (pick:YEAR:R.SS) so they
// never collide with NFL player IDs.
export function generatePickPlayers(now: Date = new Date()): TradePlayer[] {
  const [y0, y1, y2] = currentPickWindow(now);
  const years = [y0, y1, y2];
  const out: TradePlayer[] = [];
  const slots = Object.keys(PICK_CURVE);

  for (const year of years) {
    for (const key of slots) {
      const [roundStr, slotStr] = key.split(".");
      const round = Number(roundStr) as 1 | 2 | 3;
      const slot = Number(slotStr);
      const dpv = pickDpv(year, round, slot, y0);
      if (dpv <= 0) continue;
      const tier =
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
        tier,
      });
    }
  }

  // Sort by DPV descending so the highest-value picks surface first in search.
  out.sort((a, b) => b.dpv - a.dpv);
  return out;
}
