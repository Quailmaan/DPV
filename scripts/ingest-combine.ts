import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Pulls nflverse combine release and upserts into public.combine_stats.
// Also computes a 0-10 athleticism_score as a lightweight RAS approximation:
// per-position z-scores of (forty, vertical, broad_jump, bench, cone, shuttle),
// averaged across available metrics, mapped through the standard-normal CDF.
//
// Combine rows use pfr_id; our players table keys by gsis_id. We use the
// draft_picks.csv crosswalk to translate. For the current/just-drafted class
// the crosswalk lags — nflverse hasn't assigned gsis_ids to everyone yet —
// so we also keep a name+season fallback against our own players table,
// which picks up rookies as soon as they land on an NFL roster.
//
// Restricted to offensive skill positions.

const COMBINE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/combine/combine.csv";
const DRAFT_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv";

const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

type CombineRow = {
  pfr_id: string;
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

// Same normalization used elsewhere (players/rookies pages) so the
// name+season fallback matches what the UI matches on.
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseHeight(raw: string): number | null {
  // "6-4" → 76 inches. Some rows use "6' 4"" or empty; tolerate both.
  if (!raw || raw === "NA") return null;
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

function parseCombineCsv(text: string): CombineRow[] {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const idx = (name: string) => header.indexOf(name);
  const iSeason = idx("season");
  const iPfr = idx("pfr_id");
  const iPos = idx("pos");
  // nflverse uses `player_name` on the combine release. Fall back to `player`
  // defensively in case the column is renamed.
  const iName = idx("player_name") >= 0 ? idx("player_name") : idx("player");
  const iHt = idx("ht");
  const iWt = idx("wt");
  const iForty = idx("forty");
  const iBench = idx("bench");
  const iVert = idx("vertical");
  const iBroad = idx("broad_jump");
  const iCone = idx("cone");
  const iShuttle = idx("shuttle");
  if ([iSeason, iPfr, iPos].some((i) => i < 0)) {
    throw new Error(`combine.csv missing required columns: ${header.join(",")}`);
  }
  const rows: CombineRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const pfr = cols[iPfr];
    const season = Number(cols[iSeason]);
    const position = (cols[iPos] || "").toUpperCase();
    if (!pfr || pfr === "NA") continue;
    if (!Number.isFinite(season)) continue;
    if (!POSITIONS.has(position)) continue;
    const player_name = iName >= 0 ? cols[iName] ?? "" : "";
    rows.push({
      pfr_id: pfr,
      player_name,
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
  return rows;
}

async function loadPfrToGsis(): Promise<Map<string, string>> {
  const res = await fetch(DRAFT_URL);
  if (!res.ok) throw new Error(`draft_picks fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const iPfr = header.indexOf("pfr_player_id");
  const iGsis = header.indexOf("gsis_id");
  if (iPfr < 0 || iGsis < 0) {
    throw new Error(`draft_picks.csv missing pfr/gsis columns`);
  }
  const map = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const pfr = cols[iPfr];
    const gsis = cols[iGsis];
    if (pfr && pfr !== "NA" && gsis && gsis !== "NA") map.set(pfr, gsis);
  }
  return map;
}

// Fallback crosswalk: normalized "name|draft_year" → gsis_id sourced from our
// own players table. Catches rookies who've landed on a roster (so ingest
// already wrote a players row) but whose pfr_id hasn't been populated in
// nflverse's draft_picks.csv yet. Paginates because Supabase caps PostgREST
// responses at 1000.
async function loadNameSeasonCrosswalk(
  sb: SupabaseClient,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from("players")
      .select("player_id, name, draft_year")
      .not("draft_year", "is", null)
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const p of data) {
      if (!p.name || p.draft_year === null) continue;
      map.set(`${normalizeName(p.name)}|${p.draft_year}`, p.player_id);
    }
    if (data.length < PAGE) break;
  }
  return map;
}

// Directional z-score: higher = better unless lowerIsBetter is true.
function zScore(
  value: number | null,
  mean: number,
  sd: number,
  lowerIsBetter: boolean,
): number | null {
  if (value === null || sd === 0) return null;
  const z = (value - mean) / sd;
  return lowerIsBetter ? -z : z;
}

// Maps a z to a 0-10 bucket via the standard-normal CDF. Mean player → 5.0.
function zToTen(z: number): number {
  // Abramowitz & Stegun approximation of Φ(z) — good enough here.
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

type PositionStats = {
  forty: { mean: number; sd: number };
  bench: { mean: number; sd: number };
  vertical: { mean: number; sd: number };
  broad_jump: { mean: number; sd: number };
  cone: { mean: number; sd: number };
  shuttle: { mean: number; sd: number };
};

function computePositionStats(rows: CombineRow[]): Map<string, PositionStats> {
  const byPos = new Map<string, CombineRow[]>();
  for (const r of rows) {
    const arr = byPos.get(r.position) ?? [];
    arr.push(r);
    byPos.set(r.position, arr);
  }
  const result = new Map<string, PositionStats>();
  for (const [pos, arr] of byPos) {
    const stat = (key: keyof CombineRow) => {
      const vals = arr
        .map((r) => r[key])
        .filter((v): v is number => typeof v === "number");
      if (vals.length === 0) return { mean: 0, sd: 0 };
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance =
        vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      return { mean, sd: Math.sqrt(variance) };
    };
    result.set(pos, {
      forty: stat("forty"),
      bench: stat("bench"),
      vertical: stat("vertical"),
      broad_jump: stat("broad_jump"),
      cone: stat("cone"),
      shuttle: stat("shuttle"),
    });
  }
  return result;
}

function computeScore(
  row: CombineRow,
  stats: PositionStats,
): { score: number | null; count: number } {
  const parts: number[] = [];
  const add = (z: number | null) => {
    if (z !== null && Number.isFinite(z)) parts.push(z);
  };
  add(zScore(row.forty, stats.forty.mean, stats.forty.sd, true));
  add(zScore(row.vertical, stats.vertical.mean, stats.vertical.sd, false));
  add(
    zScore(
      row.broad_jump,
      stats.broad_jump.mean,
      stats.broad_jump.sd,
      false,
    ),
  );
  add(zScore(row.bench, stats.bench.mean, stats.bench.sd, false));
  add(zScore(row.cone, stats.cone.mean, stats.cone.sd, true));
  add(zScore(row.shuttle, stats.shuttle.mean, stats.shuttle.sd, true));
  if (parts.length === 0) return { score: null, count: 0 };
  const avgZ = parts.reduce((a, b) => a + b, 0) / parts.length;
  return { score: zToTen(avgZ), count: parts.length };
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("Fetching nflverse combine...");
  const res = await fetch(COMBINE_URL);
  if (!res.ok) throw new Error(`combine fetch failed: ${res.status}`);
  const text = await res.text();
  const rows = parseCombineCsv(text);
  console.log(`  ${rows.length} combine rows (QB/RB/WR/TE only)`);

  console.log("Fetching draft_picks crosswalk (pfr_id → gsis_id)...");
  const pfrToGsis = await loadPfrToGsis();
  console.log(`  ${pfrToGsis.size} crosswalk entries`);

  console.log("Loading name+season fallback crosswalk from players...");
  const nameSeasonToGsis = await loadNameSeasonCrosswalk(sb);
  console.log(`  ${nameSeasonToGsis.size} name+season fallback entries`);

  console.log("Computing position-normalized athleticism scores...");
  const posStats = computePositionStats(rows);
  for (const [pos, s] of posStats) {
    console.log(
      `  ${pos}: forty μ=${s.forty.mean.toFixed(2)} σ=${s.forty.sd.toFixed(2)}`,
    );
  }

  type Upsert = {
    player_id: string;
    pfr_id: string;
    combine_season: number;
    position: string;
    height_in: number | null;
    weight_lb: number | null;
    forty: number | null;
    bench: number | null;
    vertical: number | null;
    broad_jump: number | null;
    cone: number | null;
    shuttle: number | null;
    athleticism_score: number | null;
    metrics_count: number;
    updated_at: string;
  };

  const upserts: Upsert[] = [];
  let unmatched = 0;
  let fallbackHits = 0;
  const unmatchedBySeason = new Map<number, number>();
  for (const r of rows) {
    let gsis = pfrToGsis.get(r.pfr_id);
    if (!gsis && r.player_name) {
      // Fallback: a rookie whose pfr_id hasn't been tagged in draft_picks.csv
      // yet but who is already on an NFL roster (ingest created a players row
      // with draft_year = combine season).
      const key = `${normalizeName(r.player_name)}|${r.season}`;
      gsis = nameSeasonToGsis.get(key);
      if (gsis) fallbackHits++;
    }
    if (!gsis) {
      unmatched++;
      unmatchedBySeason.set(
        r.season,
        (unmatchedBySeason.get(r.season) ?? 0) + 1,
      );
      continue;
    }
    const stats = posStats.get(r.position);
    if (!stats) continue;
    const { score, count } = computeScore(r, stats);
    upserts.push({
      player_id: gsis,
      pfr_id: r.pfr_id,
      combine_season: r.season,
      position: r.position,
      height_in: r.height_in,
      weight_lb: r.weight_lb,
      forty: r.forty,
      bench: r.bench,
      vertical: r.vertical,
      broad_jump: r.broad_jump,
      cone: r.cone,
      shuttle: r.shuttle,
      athleticism_score: score,
      metrics_count: count,
      updated_at: new Date().toISOString(),
    });
  }
  console.log(
    `  ${upserts.length} combiners matched to gsis_id (${fallbackHits} via name+season fallback, ${unmatched} unmatched — undrafted or no roster yet)`,
  );
  if (unmatched > 0) {
    const byYear = [...unmatchedBySeason.entries()].sort(
      (a, b) => b[0] - a[0],
    );
    const recent = byYear.slice(0, 5);
    console.log(
      `  unmatched by season (top 5 recent): ${recent
        .map(([s, n]) => `${s}:${n}`)
        .join(", ")}`,
    );
  }

  // Upsert in chunks. combine_stats has a FK to players(player_id), so any
  // combiner not in our players table is dropped by Supabase. That's fine —
  // we only care about combiners we rank anyway.
  const BATCH = 500;
  let wrote = 0;
  let droppedFK = 0;
  for (let i = 0; i < upserts.length; i += BATCH) {
    const chunk = upserts.slice(i, i + BATCH);
    const { error, count } = await sb
      .from("combine_stats")
      .upsert(chunk, { onConflict: "player_id", count: "exact" });
    if (error) {
      // FK violations show up as errors with code 23503. Retry per-row so
      // one bad entry doesn't sink the whole batch.
      if (error.code === "23503") {
        for (const row of chunk) {
          const r2 = await sb
            .from("combine_stats")
            .upsert(row, { onConflict: "player_id" });
          if (r2.error && r2.error.code === "23503") droppedFK++;
          else if (r2.error) {
            console.error("combine upsert error:", r2.error);
          } else wrote++;
        }
        continue;
      }
      console.error("combine upsert error:", error);
      process.exit(1);
    }
    wrote += count ?? chunk.length;
  }
  console.log(
    `Done. Wrote ${wrote} combine_stats rows (${droppedFK} dropped: not in players table).`,
  );

  // Quick sanity: show top scorers per position.
  console.log("\nTop athleticism scores by position:");
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const top = upserts
      .filter((u) => u.position === pos && u.athleticism_score !== null)
      .sort((a, b) => (b.athleticism_score ?? 0) - (a.athleticism_score ?? 0))
      .slice(0, 3);
    console.log(
      `  ${pos}: ${top.map((t) => `${t.pfr_id}:${t.athleticism_score?.toFixed(1)}`).join(", ")}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
