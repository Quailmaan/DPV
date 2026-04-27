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

// ── Bulk variant + RAS-equivalent score ────────────────────────────────────
//
// /rookies needs combine metrics for every prospect in one shot, plus a
// 0-10 athleticism score for the RAS column. Calling fetchCombineMetrics
// per-prospect would re-parse the CSV each time (Next caches the *fetch*,
// not the parse). This variant returns the parsed rows + per-position
// stats so the page can both (a) look up by name and (b) compute the
// athleticism score inline using the same formula as scripts/ingest-combine.

export type PositionStats = {
  forty: { mean: number; sd: number };
  bench: { mean: number; sd: number };
  vertical: { mean: number; sd: number };
  broad_jump: { mean: number; sd: number };
  cone: { mean: number; sd: number };
  shuttle: { mean: number; sd: number };
};

function computePositionStats(
  rows: CombineMetrics[],
): Map<string, PositionStats> {
  const byPos = new Map<string, CombineMetrics[]>();
  for (const r of rows) {
    const arr = byPos.get(r.position) ?? [];
    arr.push(r);
    byPos.set(r.position, arr);
  }
  const result = new Map<string, PositionStats>();
  const stat = (arr: CombineMetrics[], key: keyof CombineMetrics) => {
    const vals = arr
      .map((r) => r[key])
      .filter((v): v is number => typeof v === "number");
    if (vals.length === 0) return { mean: 0, sd: 0 };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance =
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    return { mean, sd: Math.sqrt(variance) };
  };
  for (const [pos, arr] of byPos) {
    result.set(pos, {
      forty: stat(arr, "forty"),
      bench: stat(arr, "bench"),
      vertical: stat(arr, "vertical"),
      broad_jump: stat(arr, "broad_jump"),
      cone: stat(arr, "cone"),
      shuttle: stat(arr, "shuttle"),
    });
  }
  return result;
}

// Standard-normal CDF approximation. Maps a z-score to a 0-10 bucket where
// 5.0 = 50th percentile. Mirrors zToTen in scripts/ingest-combine.ts so the
// pre-draft score on /rookies lines up with the post-draft RAS in
// combine_stats once the player is ingested.
function zToTen(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-(z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  const phi = z > 0 ? 1 - p : p;
  return Math.round(phi * 1000) / 100;
}

function dirZ(
  value: number | null,
  mean: number,
  sd: number,
  lowerIsBetter: boolean,
): number | null {
  if (value === null || sd === 0) return null;
  const z = (value - mean) / sd;
  return lowerIsBetter ? -z : z;
}

/** RAS-equivalent 0-10 score from a single combine row + position stats.
 *  Returns null if the row has no usable metrics. */
export function athleticismScoreFromMetrics(
  row: CombineMetrics,
  stats: PositionStats | undefined,
): number | null {
  if (!stats) return null;
  const parts: number[] = [];
  const add = (z: number | null) => {
    if (z !== null && Number.isFinite(z)) parts.push(z);
  };
  add(dirZ(row.forty, stats.forty.mean, stats.forty.sd, true));
  add(dirZ(row.vertical, stats.vertical.mean, stats.vertical.sd, false));
  add(dirZ(row.broad_jump, stats.broad_jump.mean, stats.broad_jump.sd, false));
  add(dirZ(row.bench, stats.bench.mean, stats.bench.sd, false));
  add(dirZ(row.cone, stats.cone.mean, stats.cone.sd, true));
  add(dirZ(row.shuttle, stats.shuttle.mean, stats.shuttle.sd, true));
  if (parts.length === 0) return null;
  const avgZ = parts.reduce((a, b) => a + b, 0) / parts.length;
  return zToTen(avgZ);
}

export type CombineDataset = {
  /** name key (`normalizeCombineName(name)`) → most recent CombineMetrics row.
   *  When a prospect attended in multiple years (rare but possible), we keep
   *  the latest season — that's the row most predictive of how they trained. */
  byName: Map<string, CombineMetrics>;
  statsByPos: Map<string, PositionStats>;
};

/** Fetch + parse combine.csv once, return the full dataset for bulk use. */
export async function fetchCombineDataset(): Promise<CombineDataset> {
  try {
    const res = await fetch(COMBINE_URL, { next: { revalidate: 3600 } });
    if (!res.ok) return { byName: new Map(), statsByPos: new Map() };
    const text = await res.text();
    const rows = parseCombineCsv(text);
    const byName = new Map<string, CombineMetrics>();
    for (const r of rows) {
      const key = normalizeCombineName(r.player_name);
      const prev = byName.get(key);
      if (!prev || r.season > prev.season) byName.set(key, r);
    }
    return { byName, statsByPos: computePositionStats(rows) };
  } catch {
    return { byName: new Map(), statsByPos: new Map() };
  }
}
