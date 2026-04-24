// Fetches nflverse combine.csv and exposes a name+season lookup. Used by
// /prospect/[id] to show combine metrics for pre-draft prospects that don't
// have a gsis_id yet (so aren't in our combine_stats table).
//
// Next.js fetch caching handles the CSV refresh cadence — we revalidate once
// an hour, which is plenty for a file that only changes after each combine
// season.

const COMBINE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv";

export type CombineMetrics = {
  pfr_id: string | null;
  player_name: string;
  season: number;
  position: string;
  height_in: number | null;
  weight_lb: number | null;
  forty: number | null;
  bench: number | null;
  vertical: number | null;
  broad_jump: number | null;
  cone: number | null;
  shuttle: number | null;
};

export function normalizeCombineName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHeight(raw: string | undefined): number | null {
  if (!raw || raw === "NA") return null;
  // "6-4" → 76 inches; some rows use "6' 4"" or a plain decimal.
  const m = raw.match(/^(\d+)[-' ]+(\d+)/);
  if (m) return Number(m[1]) * 12 + Number(m[2]);
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function num(raw: string | undefined): number | null {
  if (raw === undefined || raw === "" || raw === "NA") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function parseCombineCsv(text: string): CombineMetrics[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return [];
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const idx = (name: string) => header.indexOf(name);
  const iSeason = idx("season");
  const iPfr = idx("pfr_id");
  const iPos = idx("pos");
  const iName = idx("player_name") >= 0 ? idx("player_name") : idx("player");
  const iHt = idx("ht");
  const iWt = idx("wt");
  const iForty = idx("forty");
  const iBench = idx("bench");
  const iVert = idx("vertical");
  const iBroad = idx("broad_jump");
  const iCone = idx("cone");
  const iShuttle = idx("shuttle");
  if ([iSeason, iPos, iName].some((i) => i < 0)) return [];

  const out: CombineMetrics[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const season = Number(cols[iSeason]);
    if (!Number.isFinite(season)) continue;
    const position = (cols[iPos] || "").toUpperCase();
    const name = cols[iName] ?? "";
    if (!name) continue;
    out.push({
      pfr_id: cols[iPfr] && cols[iPfr] !== "NA" ? cols[iPfr] : null,
      player_name: name,
      season,
      position,
      height_in: parseHeight(cols[iHt]),
      weight_lb: num(cols[iWt]),
      forty: num(cols[iForty]),
      bench: num(cols[iBench]),
      vertical: num(cols[iVert]),
      broad_jump: num(cols[iBroad]),
      cone: num(cols[iCone]),
      shuttle: num(cols[iShuttle]),
    });
  }
  return out;
}

// Fetches the combine CSV with Next.js server-side caching (1h revalidation).
// Any caller on the same server shares the cache. Failures return an empty
// array so the consumer degrades gracefully instead of throwing.
export async function fetchCombineMetrics(
  name: string,
  season: number,
): Promise<CombineMetrics | null> {
  try {
    const res = await fetch(COMBINE_URL, {
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const rows = parseCombineCsv(text);
    const key = normalizeCombineName(name);
    // Prefer an exact (name, season) match. Fall back to name-only if the
    // prospect attended the combine in a year other than their projected
    // draft year (e.g. they went back to school post-combine).
    let hit: CombineMetrics | null = null;
    for (const r of rows) {
      if (normalizeCombineName(r.player_name) !== key) continue;
      if (r.season === season) return r;
      if (!hit) hit = r;
    }
    return hit;
  } catch {
    return null;
  }
}
