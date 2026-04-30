// Backfill dpv_history with one snapshot per (player × past season)
// using the as-of compute. Run once after the season/week migration to
// populate prior seasons; re-run after each NFL season ends to add a
// new season-end row. Safe to re-run — UPSERTs on the (player_id,
// scoring_format, snapshot_date) primary key.
//
// Snapshot date convention for season-end rows: Feb 15 of (season+1).
// That's after every Super Bowl (which falls early Feb), so the row's
// `snapshot_date` is unambiguous and consistent year-over-year. The
// `season` column carries the NFL season the row represents, and
// `week` is set to 22 (Super Bowl week) to mark this as a season-end
// aggregate vs. an in-season weekly snapshot.
//
// Usage:
//   npx tsx scripts/backfill-historical-dpv.ts                # all seasons 2013-2025
//   npx tsx scripts/backfill-historical-dpv.ts 2021 2022 2023 # specific seasons
//   DRY_RUN=1 npx tsx scripts/backfill-historical-dpv.ts      # compute, don't write
//
// Validation flags (don't write, just print top-N for inspection):
//   VALIDATE=AmonRa npx tsx scripts/backfill-historical-dpv.ts 2024
//
// Two implicit assumptions baked in:
//   1. player_seasons.team accurately reflects which team a player was
//      on for each season (verified up to 2013 in production).
//   2. team_seasons has 32 rows per past season (verified — fully
//      populated 2013-2025).
// If either breaks, the affected snapshots silently fall back to
// neutral mid-pack contexts (oline_rank=16, qb_tier=3).

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import {
  computeDpvAsOfSeason,
  type AsOfDpvOutput,
  type PlayerProfileRow,
  type PlayerSeasonRow,
  type TeamSeasonRow,
} from "../src/lib/dpv/asOfCompute";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const DRY_RUN = !!process.env.DRY_RUN;
const VALIDATE = process.env.VALIDATE ?? null;

// Default backfill window. player_seasons + team_seasons are both
// populated 2013-2025 in our DB, but this script targets seasons
// AFTER each player's draft_year so we don't try to compute pre-NFL
// values. The actual season range that produces output depends on
// each player's career.
const DEFAULT_SEASONS = [
  2013,
  2014,
  2015,
  2016,
  2017,
  2018,
  2019,
  2020,
  2021,
  2022,
  2023,
  2024,
  2025,
];

async function fetchAll<T>(table: string, select = "*"): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return all;
}

function snapshotDateForSeason(season: number): string {
  // Feb 15 of (season+1). After every Super Bowl, before any
  // free-agency activity that would change next year's outlook.
  return `${season + 1}-02-15`;
}

async function main() {
  const args = process.argv.slice(2);
  const seasons =
    args.length > 0
      ? args.map((a) => Number(a)).filter((n) => Number.isFinite(n))
      : DEFAULT_SEASONS;

  console.log(`Backfilling seasons: ${seasons.join(", ")}`);
  console.log(`DRY_RUN=${DRY_RUN ? "yes" : "no"}`);
  if (VALIDATE) console.log(`VALIDATE=${VALIDATE} (will print, not write)`);

  console.log("\nLoading source tables...");
  const [players, playerSeasons, teamSeasons] = await Promise.all([
    fetchAll<PlayerProfileRow>(
      "players",
      "player_id, name, position, birthdate",
    ),
    fetchAll<PlayerSeasonRow>("player_seasons"),
    fetchAll<TeamSeasonRow>("team_seasons"),
  ]);
  console.log(
    `  players=${players.length} player_seasons=${playerSeasons.length} team_seasons=${teamSeasons.length}`,
  );

  let totalRows = 0;
  let totalUnique = 0;

  for (const season of seasons) {
    console.log(`\n=== Season ${season} ===`);
    const out = computeDpvAsOfSeason({
      targetSeason: season,
      players,
      playerSeasons,
      teamSeasons,
    });
    const uniquePlayers = new Set(out.map((r) => r.player_id)).size;
    totalRows += out.length;
    totalUnique += uniquePlayers;
    console.log(
      `  computed ${out.length} rows across ${uniquePlayers} unique players`,
    );

    if (VALIDATE) {
      const needle = VALIDATE.toLowerCase().replace(/[^a-z]/g, "");
      const matchedPlayers = players.filter((p) =>
        p.name.toLowerCase().replace(/[^a-z]/g, "").includes(needle),
      );
      for (const p of matchedPlayers) {
        const rows = out.filter(
          (r) => r.player_id === p.player_id && r.scoring_format === "HALF_PPR",
        );
        for (const r of rows) {
          console.log(
            `  ${p.name} (${p.position}) S=${season}  DPV=${r.dpv}  Tier=${r.tier}`,
          );
        }
      }
      // Also print top-5 at each position so we can sanity-check tier shape.
      const byPos: Record<string, AsOfDpvOutput[]> = {};
      for (const r of out) {
        if (r.scoring_format !== "HALF_PPR") continue;
        const pos =
          players.find((p) => p.player_id === r.player_id)?.position ?? "??";
        const arr = byPos[pos] ?? [];
        arr.push(r);
        byPos[pos] = arr;
      }
      for (const pos of ["QB", "RB", "WR", "TE"]) {
        const arr = (byPos[pos] ?? [])
          .sort((a, b) => b.dpv - a.dpv)
          .slice(0, 5);
        console.log(`  Top-5 ${pos}:`);
        for (const r of arr) {
          const name =
            players.find((p) => p.player_id === r.player_id)?.name ?? "??";
          console.log(`    ${r.dpv}  ${name}  (${r.tier})`);
        }
      }
      continue;
    }

    if (DRY_RUN) continue;

    const snapshotDate = snapshotDateForSeason(season);
    const rows = out.map((r) => ({
      player_id: r.player_id,
      scoring_format: r.scoring_format,
      snapshot_date: snapshotDate,
      dpv: r.dpv,
      breakdown: r.breakdown,
      season: r.season,
      week: 22, // season-end (Super Bowl week) aggregate marker
    }));

    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await sb
        .from("dpv_history")
        .upsert(chunk, {
          onConflict: "player_id,scoring_format,snapshot_date",
        });
      if (error) {
        console.error(`  ❌ Upsert error in season ${season}:`, error);
        process.exit(1);
      }
    }
    console.log(`  wrote ${rows.length} rows (snapshot_date=${snapshotDate})`);
  }

  console.log(
    `\nDone. ${totalRows} total rows across ${totalUnique} (player×season) combinations.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
