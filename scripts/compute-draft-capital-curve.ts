import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import { resolve } from "path";
import { CURRENT_SEASON } from "../src/lib/dpv/constants";

// Empirical Year-1 fantasy performance by (position × overall-pick bucket).
// Replaces the crude round-only base in rookie-prior with a fine-grained
// within-round signal. Exclusively consumed by the rookie prior path — never
// touches veteran DPV.
//
// Output: src/lib/dpv/draft-capital-curve.json
// Shape:  { [position]: { [bucket]: { n, qualifierRate, meanYear1PPG, ... } } }

const CSV_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv";
// Must match the ingest coverage window — our player_seasons table starts at
// 2013, so earlier draftees would be mis-labeled as non-qualifiers simply
// because we lack their Year-1 data. 2013+ gives us a full PPR-era sample
// anyway, which matches current NFL usage patterns better than 2000s data.
const LOOKBACK_MIN_SEASON = 2013;
// Latest fully-observed rookie cohort. 2025 draftees completed their Year-1
// during the 2025 season, which CURRENT_SEASON already reflects.
const LOOKBACK_MAX_SEASON = CURRENT_SEASON;

const POSITIONS = ["QB", "RB", "WR", "TE"] as const;
type Position = (typeof POSITIONS)[number];

// Bucket edges chosen so each bucket has enough RB/WR samples across 25 years
// (TE samples are sparser; noted in the report).
const PICK_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "1-10", min: 1, max: 10 },
  { label: "11-20", min: 11, max: 20 },
  { label: "21-32", min: 21, max: 32 },
  { label: "33-50", min: 33, max: 50 },
  { label: "51-75", min: 51, max: 75 },
  { label: "76-100", min: 76, max: 100 },
  { label: "101-150", min: 101, max: 150 },
  { label: "151+", min: 151, max: 300 },
];

function bucketOf(pick: number): string | null {
  for (const b of PICK_BUCKETS) {
    if (pick >= b.min && pick <= b.max) return b.label;
  }
  return null;
}

type DraftRow = {
  season: number;
  pick: number;
  round: number;
  gsis_id: string;
  position: Position;
};

async function fetchDraftPicks(): Promise<DraftRow[]> {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const iSeason = header.indexOf("season");
  const iPick = header.indexOf("pick");
  const iRound = header.indexOf("round");
  const iGsis = header.indexOf("gsis_id");
  const iPos = header.indexOf("position");
  if ([iSeason, iPick, iRound, iGsis, iPos].some((i) => i < 0)) {
    throw new Error(`draft_picks.csv missing columns: ${header.join(",")}`);
  }

  const rows: DraftRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const season = Number(cols[iSeason]);
    const pick = Number(cols[iPick]);
    const round = Number(cols[iRound]);
    const gsis = cols[iGsis];
    const pos = cols[iPos];
    if (!Number.isFinite(season) || !Number.isFinite(pick)) continue;
    if (!gsis || gsis === "NA") continue;
    if (season < LOOKBACK_MIN_SEASON || season > LOOKBACK_MAX_SEASON) continue;
    if (!POSITIONS.includes(pos as Position)) continue;
    rows.push({ season, pick, round, gsis_id: gsis, position: pos as Position });
  }
  return rows;
}

type Year1 = { games: number; ppg: number };

async function loadYear1Stats(
  sb: SupabaseClient,
  picks: DraftRow[],
): Promise<Map<string, Year1>> {
  const byGsisDraftSeason = new Map<string, number>();
  for (const p of picks) byGsisDraftSeason.set(p.gsis_id, p.season);

  const gsisIds = [...byGsisDraftSeason.keys()];
  // Supabase project caps responses at 1000 rows regardless of .range(),
  // so keep chunks small enough that all rows fit under the cap. 60 players
  // × up to 13 seasons ≈ 780 rows, well under the limit.
  const BATCH = 60;
  const result = new Map<string, Year1>();

  for (let i = 0; i < gsisIds.length; i += BATCH) {
    const chunk = gsisIds.slice(i, i + BATCH);
    const { data, error } = await sb
      .from("player_seasons")
      .select("player_id, season, games_played, weekly_fantasy_points_half")
      .in("player_id", chunk);
    if (error) throw error;

    for (const r of (data as Array<{
      player_id: string;
      season: number;
      games_played: number | null;
      weekly_fantasy_points_half: number[] | null;
    }>) ?? []) {
      const draftSeason = byGsisDraftSeason.get(r.player_id);
      if (draftSeason === undefined) continue;
      // Year-1 = draft season. Some players sit out (IR) and first observable
      // season is draft_season + 1; those count as "no Year-1 production".
      if (r.season !== draftSeason) continue;
      const pts = r.weekly_fantasy_points_half ?? [];
      const ppg = pts.length > 0 ? pts.reduce((a, b) => a + b, 0) / pts.length : 0;
      result.set(r.player_id, { games: r.games_played ?? 0, ppg });
    }
  }
  return result;
}

type BucketAgg = {
  n: number;
  qualifiers: number;
  sumPPGAll: number;
  sumPPGQualifiers: number;
};

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("Fetching nflverse draft_picks...");
  const picks = await fetchDraftPicks();
  console.log(
    `  ${picks.length} picks (${LOOKBACK_MIN_SEASON}-${LOOKBACK_MAX_SEASON}, skill positions)`,
  );

  console.log("Loading Year-1 stats from player_seasons...");
  const year1 = await loadYear1Stats(sb, picks);
  console.log(`  ${year1.size} players have Year-1 rows`);

  const agg = new Map<string, BucketAgg>();
  for (const p of picks) {
    const bucket = bucketOf(p.pick);
    if (!bucket) continue;
    const key = `${p.position}|${bucket}`;
    const s = agg.get(key) ?? {
      n: 0,
      qualifiers: 0,
      sumPPGAll: 0,
      sumPPGQualifiers: 0,
    };
    s.n++;
    const y1 = year1.get(p.gsis_id);
    if (y1 && y1.games >= 7) {
      s.qualifiers++;
      s.sumPPGAll += y1.ppg;
      s.sumPPGQualifiers += y1.ppg;
    }
    agg.set(key, s);
  }

  type Row = {
    position: Position;
    bucket: string;
    minPick: number;
    maxPick: number;
    n: number;
    qualifierRate: number;
    meanYear1PPG: number;
    conditionalMeanPPG: number;
  };
  const rows: Row[] = [];
  for (const pos of POSITIONS) {
    for (const b of PICK_BUCKETS) {
      const s = agg.get(`${pos}|${b.label}`) ?? {
        n: 0,
        qualifiers: 0,
        sumPPGAll: 0,
        sumPPGQualifiers: 0,
      };
      rows.push({
        position: pos,
        bucket: b.label,
        minPick: b.min,
        maxPick: b.max,
        n: s.n,
        qualifierRate: s.n > 0 ? s.qualifiers / s.n : 0,
        meanYear1PPG: s.n > 0 ? s.sumPPGAll / s.n : 0,
        conditionalMeanPPG:
          s.qualifiers > 0 ? s.sumPPGQualifiers / s.qualifiers : 0,
      });
    }
  }

  console.log("\nDraft Capital Curve (Year-1 fantasy relevance by pick bucket)\n");
  console.log(
    "pos | bucket   |   n  | Y1qual% | meanPPG | condPPG (qualifiers only)",
  );
  console.log("----+----------+------+---------+---------+---------");
  for (const r of rows) {
    const warn = r.n < 15 ? " ⚠ low-n" : "";
    console.log(
      `${r.position.padEnd(3)} | ${r.bucket.padEnd(8)} | ${String(r.n).padStart(4)} | ${(
        r.qualifierRate * 100
      )
        .toFixed(0)
        .padStart(6)}% | ${r.meanYear1PPG.toFixed(2).padStart(7)} | ${r.conditionalMeanPPG
        .toFixed(2)
        .padStart(7)}${warn}`,
    );
  }

  // Write nested JSON for easy lookup in rookie-prior.ts.
  const out: {
    metadata: { computedAt: string; seasonRange: string; totalPicks: number };
    curve: Record<string, Record<string, Omit<Row, "position" | "bucket">>>;
  } = {
    metadata: {
      computedAt: new Date().toISOString(),
      seasonRange: `${LOOKBACK_MIN_SEASON}-${LOOKBACK_MAX_SEASON}`,
      totalPicks: picks.length,
    },
    curve: {},
  };
  for (const r of rows) {
    out.curve[r.position] ??= {};
    out.curve[r.position][r.bucket] = {
      minPick: r.minPick,
      maxPick: r.maxPick,
      n: r.n,
      qualifierRate: Number(r.qualifierRate.toFixed(4)),
      meanYear1PPG: Number(r.meanYear1PPG.toFixed(3)),
      conditionalMeanPPG: Number(r.conditionalMeanPPG.toFixed(3)),
    };
  }

  const outPath = resolve("src/lib/dpv/draft-capital-curve.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
