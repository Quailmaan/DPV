/**
 * Print position-rank deltas between the two most recent distinct
 * snapshot_dates in dpv_history. Used after a compute-dpv run to
 * see which players moved most under an algorithm change.
 *
 * Workflow for validating the new efficiency multiplier:
 *   1. Run `npx tsx scripts/compute-dpv.ts` (writes today's row to
 *      dpv_history under the NEW algorithm).
 *   2. Run this script — it compares today vs. the most recent
 *      prior date (which was computed under the OLD algorithm).
 *   3. Eyeball the climbers/droppers list. Sane:
 *        - Elite-efficiency starters move up 1-3 ranks.
 *        - Inefficient high-volume players move down similarly.
 *        - Median players barely shift.
 *      Insane (would warrant rolling back):
 *        - Backup QBs jumping into top-10 (sample-size noise).
 *        - Career starters dropping 20+ ranks (broken signal).
 *
 * Run: `npx tsx scripts/diff-recent-ranks.ts`
 *
 * If the gap between dates spans weeks/months, the diff also reflects
 * roster moves and aging — not just the algorithm change. Script warns
 * if the prior date is more than 7 days back so you don't read too
 * much into noisy long-gap diffs.
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

// HALF_PPR is the default scoring format on Pylon and the most common
// in dynasty leagues. Diff is keyed off this format only — extending
// to all three would 3x the output for marginal extra signal.
const FORMAT = "HALF_PPR";

// How many climbers/droppers to print per position. Top 10 each is
// enough to spot the pattern without flooding the terminal.
const TOP_N = 12;

type HistoryRow = { player_id: string; snapshot_date: string; dpv: number };
type Player = {
  player_id: string;
  name: string;
  position: "QB" | "RB" | "WR" | "TE";
};

async function fetchAll<T>(
  table: string,
  columns: string,
  filter?: (q: ReturnType<ReturnType<typeof sb.from>["select"]>) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    let q = sb.from(table).select(columns) as ReturnType<
      ReturnType<typeof sb.from>["select"]
    >;
    if (filter) q = filter(q) as typeof q;
    const { data, error } = await q.range(start, start + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

async function main() {
  // Find recent distinct snapshot dates. We pull a small window, dedupe,
  // and take the top two — covers both the "ran 2 days in a row" and
  // "ran today + last run was 30 days ago" cases.
  console.log("Finding recent snapshot dates...");
  const { data: dateRows, error: dateErr } = await sb
    .from("dpv_history")
    .select("snapshot_date")
    .eq("scoring_format", FORMAT)
    .order("snapshot_date", { ascending: false })
    .limit(500);
  if (dateErr) throw dateErr;

  const distinctDates = [
    ...new Set((dateRows ?? []).map((r) => r.snapshot_date as string)),
  ];
  if (distinctDates.length < 2) {
    console.log(
      `Need at least 2 distinct snapshot_dates in dpv_history. Found: ${JSON.stringify(distinctDates)}`,
    );
    console.log(
      "Run `npx tsx scripts/compute-dpv.ts` to produce today's row, then re-run.",
    );
    return;
  }

  const [newDate, oldDate] = distinctDates;
  const dayGap = Math.round(
    (new Date(newDate).getTime() - new Date(oldDate).getTime()) /
      (24 * 3600 * 1000),
  );
  console.log(`Comparing ${oldDate} → ${newDate}  (${dayGap} day gap)\n`);
  if (dayGap > 7) {
    console.log(
      "WARNING: gap > 7 days. Diff includes player aging + ingested data,",
    );
    console.log(
      "         not just the algorithm change. Read movers with caution.\n",
    );
  }

  const [oldRows, newRows, players] = await Promise.all([
    fetchAll<HistoryRow>(
      "dpv_history",
      "player_id,snapshot_date,dpv",
      (q) =>
        (q as ReturnType<ReturnType<typeof sb.from>["select"]>)
          .eq("scoring_format", FORMAT)
          .eq("snapshot_date", oldDate),
    ),
    fetchAll<HistoryRow>(
      "dpv_history",
      "player_id,snapshot_date,dpv",
      (q) =>
        (q as ReturnType<ReturnType<typeof sb.from>["select"]>)
          .eq("scoring_format", FORMAT)
          .eq("snapshot_date", newDate),
    ),
    fetchAll<Player>("players", "player_id,name,position"),
  ]);

  console.log(
    `  Loaded: ${oldRows.length} old, ${newRows.length} new, ${players.length} players\n`,
  );

  const playerById = new Map<string, Player>();
  for (const p of players) playerById.set(p.player_id, p);

  const oldByPlayer = new Map<string, number>();
  for (const r of oldRows) oldByPlayer.set(r.player_id, r.dpv);
  const newByPlayer = new Map<string, number>();
  for (const r of newRows) newByPlayer.set(r.player_id, r.dpv);

  // Per-position rank within each date. We compute ranks AFTER joining
  // so a player who appears in only one snapshot doesn't shift everyone
  // else's rank by one. Players present in both snapshots get an
  // oldRank and newRank derived from sorting only that overlap set —
  // matches what users perceive ("of the players I've been tracking,
  // who moved?").
  for (const pos of ["QB", "RB", "WR", "TE"] as const) {
    const overlap = players
      .filter((p) => p.position === pos)
      .filter(
        (p) =>
          oldByPlayer.has(p.player_id) && newByPlayer.has(p.player_id),
      )
      .map((p) => ({
        player_id: p.player_id,
        name: p.name,
        oldDpv: oldByPlayer.get(p.player_id)!,
        newDpv: newByPlayer.get(p.player_id)!,
      }));

    const oldRanks = new Map<string, number>();
    [...overlap]
      .sort((a, b) => b.oldDpv - a.oldDpv)
      .forEach((p, i) => oldRanks.set(p.player_id, i + 1));
    const newRanks = new Map<string, number>();
    [...overlap]
      .sort((a, b) => b.newDpv - a.newDpv)
      .forEach((p, i) => newRanks.set(p.player_id, i + 1));

    const withDelta = overlap.map((p) => {
      const oldRank = oldRanks.get(p.player_id)!;
      const newRank = newRanks.get(p.player_id)!;
      return {
        ...p,
        oldRank,
        newRank,
        rankDelta: oldRank - newRank, // + = climber, - = dropper
        dpvDelta: p.newDpv - p.oldDpv,
      };
    });

    console.log(`=== ${pos} (${overlap.length} players in both snapshots) ===`);

    // Filter to only meaningful starters in the position rank window —
    // a backup WR moving from #220 to #205 isn't a story. Cap at the
    // typical "fantasy relevant" depth per position.
    const RANK_WINDOW = { QB: 36, RB: 60, WR: 80, TE: 30 }[pos];
    const inWindow = withDelta.filter(
      (d) => d.oldRank <= RANK_WINDOW || d.newRank <= RANK_WINDOW,
    );

    const climbers = [...inWindow]
      .filter((d) => d.rankDelta > 0)
      .sort((a, b) => b.rankDelta - a.rankDelta)
      .slice(0, TOP_N);
    const droppers = [...inWindow]
      .filter((d) => d.rankDelta < 0)
      .sort((a, b) => a.rankDelta - b.rankDelta)
      .slice(0, TOP_N);

    console.log(`  Climbers (rank up):`);
    if (climbers.length === 0) console.log("    (none)");
    for (const d of climbers) {
      const arrow = `#${d.oldRank} → #${d.newRank}`.padEnd(14);
      const dpvStr = `${d.oldDpv}→${d.newDpv}`.padStart(11);
      const dpvDeltaStr = (d.dpvDelta >= 0 ? "+" : "") + d.dpvDelta;
      console.log(
        `    +${String(d.rankDelta).padStart(2)}  ${d.name.padEnd(26)} ${arrow}  PYV ${dpvStr}  (${dpvDeltaStr})`,
      );
    }

    console.log(`  Droppers (rank down):`);
    if (droppers.length === 0) console.log("    (none)");
    for (const d of droppers) {
      const arrow = `#${d.oldRank} → #${d.newRank}`.padEnd(14);
      const dpvStr = `${d.oldDpv}→${d.newDpv}`.padStart(11);
      const dpvDeltaStr = (d.dpvDelta >= 0 ? "+" : "") + d.dpvDelta;
      console.log(
        `    ${String(d.rankDelta).padStart(3)}  ${d.name.padEnd(26)} ${arrow}  PYV ${dpvStr}  (${dpvDeltaStr})`,
      );
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
