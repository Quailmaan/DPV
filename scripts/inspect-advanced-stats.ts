/**
 * Print position-level distribution stats for the advanced metrics
 * we just ingested. Used once after the first ingest run to calibrate
 * the efficiency multiplier in src/lib/dpv/efficiency.ts.
 *
 * Without seeing real distributions, we'd be picking median/spread
 * constants out of thin air. This script grounds those choices.
 *
 * Run: `npx tsx scripts/inspect-advanced-stats.ts`
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// Last full season to inspect — most populated, freshest sample.
// Adjust if you want to compare across years.
const SEASON = 2024;

// Per-position minimum opportunity threshold for inclusion. Below
// these, EPA is dominated by sample noise — a 4-target WR with one
// 50-yard catch shows EPA-per-target an order of magnitude above any
// real player. Same thresholds we'll use in the runtime multiplier
// to drop low-sample seasons to neutral (1.0x).
const MIN_OPPS = {
  QB: 100,
  RB: 50,
  WR: 30,
  TE: 25,
};

type Row = {
  player_id: string;
  season: number;
  passing_epa_per_dropback: number | null;
  rushing_epa_per_carry: number | null;
  receiving_epa_per_target: number | null;
  avg_adot: number | null;
  yac_per_reception: number | null;
  dropbacks: number;
  carries: number;
  targets: number;
  receptions: number;
};

type Player = {
  player_id: string;
  name: string;
  position: "QB" | "RB" | "WR" | "TE";
};

// Quantile from a sorted array. Linear interpolation between the two
// neighbors when the requested quantile doesn't land on an integer
// index (most of the time).
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const frac = pos - lo;
  return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}

function fmt(n: number, digits = 3): string {
  return n.toFixed(digits).padStart(7);
}

async function main() {
  console.log(`Inspecting advanced stats for ${SEASON} season\n`);

  const [{ data: rows }, { data: players }] = await Promise.all([
    sb
      .from("player_advanced_stats")
      .select(
        "player_id,season,passing_epa_per_dropback,rushing_epa_per_carry,receiving_epa_per_target,avg_adot,yac_per_reception,dropbacks,carries,targets,receptions",
      )
      .eq("season", SEASON),
    sb.from("players").select("player_id,name,position"),
  ]);

  if (!rows || rows.length === 0) {
    console.log(`No rows in player_advanced_stats for season=${SEASON}.`);
    console.log("Run scripts/ingest.py first.");
    return;
  }

  const playerById = new Map<string, Player>();
  for (const p of (players ?? []) as Player[]) {
    playerById.set(p.player_id, p);
  }

  // Bucket each row by the player's roster position so we report
  // QB efficiency separately from WR efficiency, etc.
  const buckets: Record<string, Row[]> = { QB: [], RB: [], WR: [], TE: [] };
  for (const r of rows as Row[]) {
    const p = playerById.get(r.player_id);
    if (!p) continue;
    if (!(p.position in buckets)) continue;
    buckets[p.position].push(r);
  }

  for (const pos of ["QB", "RB", "WR", "TE"] as const) {
    const all = buckets[pos];
    const min = MIN_OPPS[pos];
    console.log(`=== ${pos} (n=${all.length}, min-opp threshold=${min}) ===`);

    // Pick the relevant per-opportunity field for this position.
    const effField =
      pos === "QB"
        ? "passing_epa_per_dropback"
        : pos === "RB"
        ? "rushing_epa_per_carry"
        : "receiving_epa_per_target";
    const oppField =
      pos === "QB" ? "dropbacks" : pos === "RB" ? "carries" : "targets";

    const eligible = all.filter(
      (r) =>
        r[effField as keyof Row] !== null &&
        (r[oppField as keyof Row] as number) >= min,
    );
    console.log(`  ${eligible.length} above threshold`);

    if (eligible.length > 0) {
      const sorted = eligible
        .map((r) => r[effField as keyof Row] as number)
        .sort((a, b) => a - b);
      console.log(
        `  ${effField}:  p10=${fmt(quantile(sorted, 0.1))}  p25=${fmt(quantile(sorted, 0.25))}  p50=${fmt(quantile(sorted, 0.5))}  p75=${fmt(quantile(sorted, 0.75))}  p90=${fmt(quantile(sorted, 0.9))}`,
      );
      // Top + bottom 5 to sanity check — any obviously wrong row
      // (eg. a kicker miscategorized as WR) shows up here.
      const named = eligible
        .map((r) => ({
          name: playerById.get(r.player_id)?.name ?? r.player_id,
          eff: r[effField as keyof Row] as number,
          opps: r[oppField as keyof Row] as number,
        }))
        .sort((a, b) => b.eff - a.eff);
      console.log(`  Top 5:`);
      for (const r of named.slice(0, 5)) {
        console.log(
          `    ${r.name.padEnd(30)} ${fmt(r.eff)}  (${r.opps} opps)`,
        );
      }
      console.log(`  Bottom 5:`);
      for (const r of named.slice(-5).reverse()) {
        console.log(
          `    ${r.name.padEnd(30)} ${fmt(r.eff)}  (${r.opps} opps)`,
        );
      }
    }

    // Receiving-profile metrics (aDOT/YAC) — only meaningful for
    // pass-catchers. Skip QB/RB to keep the output focused.
    if (pos === "WR" || pos === "TE") {
      const adots = all
        .filter((r) => r.avg_adot !== null && r.targets >= min)
        .map((r) => r.avg_adot as number)
        .sort((a, b) => a - b);
      const yacs = all
        .filter((r) => r.yac_per_reception !== null && r.receptions >= min / 2)
        .map((r) => r.yac_per_reception as number)
        .sort((a, b) => a - b);
      if (adots.length > 0) {
        console.log(
          `  avg_adot:                   p10=${fmt(quantile(adots, 0.1), 2)}  p50=${fmt(quantile(adots, 0.5), 2)}  p90=${fmt(quantile(adots, 0.9), 2)}`,
        );
      }
      if (yacs.length > 0) {
        console.log(
          `  yac_per_reception:          p10=${fmt(quantile(yacs, 0.1), 2)}  p50=${fmt(quantile(yacs, 0.5), 2)}  p90=${fmt(quantile(yacs, 0.9), 2)}`,
        );
      }
    }

    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
