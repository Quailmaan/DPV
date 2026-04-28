// Per-position rank delta — DPV rank vs. FantasyCalc market rank.
// Positive = DPV ranks higher (lower number) than market = Buy signal.
// Negative = market ranks higher = Sell signal.
//
// Only meaningful within the intersection of players that have BOTH a
// DPV and a market value. A 5-rank gap at WR means more than at TE
// because positions have different depths — but the absolute rank diff
// is the right input regardless, because all downstream consumers (the
// trade calculator's badges, the sell-window indicator) compare rank
// gaps within the same position.
//
// Extracted from `app/trade/page.tsx` so the player page and league
// roster view can compute the same delta without duplicating the math.

type RankInput = {
  id: string;
  position: string;
  dpv: number;
  /** FantasyCalc market value, or null if not present in the source. */
  market: number | null;
};

export function buildMarketDeltaMap(
  players: ReadonlyArray<RankInput>,
): Map<string, number> {
  const out = new Map<string, number>();
  const positions = Array.from(new Set(players.map((p) => p.position)));
  for (const pos of positions) {
    const inPos = players.filter(
      (p) => p.position === pos && p.market !== null,
    );
    if (inPos.length === 0) continue;
    const dpvSorted = [...inPos].sort((a, b) => b.dpv - a.dpv);
    const mktSorted = [...inPos].sort(
      (a, b) => (b.market ?? 0) - (a.market ?? 0),
    );
    const dpvRank = new Map(dpvSorted.map((p, i) => [p.id, i + 1]));
    const mktRank = new Map(mktSorted.map((p, i) => [p.id, i + 1]));
    for (const p of inPos) {
      const dr = dpvRank.get(p.id);
      const mr = mktRank.get(p.id);
      if (dr === undefined || mr === undefined) continue;
      // Positive delta = DPV ranks higher (lower number) than market = Buy.
      out.set(p.id, mr - dr);
    }
  }
  return out;
}
