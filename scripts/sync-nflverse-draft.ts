/**
 * Sync actual NFL Draft results from nflverse into the prospects
 * table as a `NFLVERSE_<year>_DRAFT` source. Replaces my speculative
 * PYLON_SEED entries with ground truth — every offensive skill pick
 * with their real round and overall pick number.
 *
 * Output:
 *   - data/prospects.csv: PYLON_SEED + prior NFLVERSE_<year>_DRAFT
 *     entries removed, fresh NFLVERSE_<year>_DRAFT block appended.
 *   - prospects table: same delete + upsert applied to keep the DB
 *     in sync with the CSV (CSV stays the human-readable source of
 *     truth; DB is what the rookies page actually reads).
 *
 * Idempotent — re-runs after a roster correction in nflverse will
 * just upsert with the latest data and produce the same CSV state.
 *
 * Usage:
 *   npx tsx scripts/sync-nflverse-draft.ts            # default 2026
 *   npx tsx scripts/sync-nflverse-draft.ts 2027       # other years
 *
 * After running:
 *   npx tsx scripts/compute-prospect-consensus.ts
 *   (rebuilds prospect_consensus from the updated prospects table —
 *    the /rookies page reflects the change on next load)
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const NFLVERSE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv";
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);
const CSV_PATH = path.join(process.cwd(), "data", "prospects.csv");

// Speculative seed source we want to retire once ground truth is in.
// Cleared from both CSV and DB on each run for the target draft year.
const SEED_SOURCE_LABEL = "PYLON_SEED";

// Strip Jr./Sr./II/III/etc. suffixes for slug consistency. Matches
// the prospect_id convention used elsewhere in data/prospects.csv,
// so a slug from this script (`harrison-marvin-2024`) aggregates
// with any other source's row carrying the same slug.
function slugify(fullName: string, year: number): string {
  const cleaned = fullName.replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/gi, "").trim();
  const parts = cleaned.split(/\s+/);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  if (parts.length < 2) return `${norm(parts[0] ?? "")}-${year}`;
  return `${norm(parts[parts.length - 1])}-${norm(parts[0])}-${year}`;
}

// Synthetic grade derived from pick number. compute-prospect-consensus
// ranks within each source by descending grade, so we just need a
// monotonic transform: higher grade ↔ earlier pick. Linear works
// because no draft has more than 257 picks. Choosing 1000 as the
// constant keeps all values positive and on a familiar order of
// magnitude relative to other sources' grades (KTC's ~9000s,
// scout grades' 0-100s — close enough for the ranking math).
function gradeFromPick(pick: number): number {
  return 1000 - pick;
}

type ProspectRow = {
  prospect_id: string;
  source: string;
  draft_year: number;
  name: string;
  position: string;
  consensus_grade: number;
  projected_round: number;
  projected_overall_pick: number;
};

async function main() {
  const yearArg = process.argv[2];
  const draftYear = yearArg ? parseInt(yearArg, 10) : 2026;
  if (!Number.isFinite(draftYear)) {
    console.error(`Invalid year: ${yearArg}`);
    process.exit(1);
  }
  const sourceName = `NFLVERSE_${draftYear}_DRAFT`;
  // Sources to strip from CSV + DB on each run. Re-running for a
  // different year leaves other years' data alone (only the matching
  // SEED + target-year NFLVERSE rows get swept).
  const stripSources = new Set([SEED_SOURCE_LABEL, sourceName]);

  console.log(`Syncing ${draftYear} NFL Draft from nflverse`);
  console.log(`Fetching ${NFLVERSE_URL}...`);
  const res = await fetch(NFLVERSE_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from nflverse`);
  const text = await res.text();

  // ── Parse the CSV ──────────────────────────────────────────────
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iSeason = idx("season");
  const iRound = idx("round");
  const iPick = idx("pick");
  const iName = idx("pfr_player_name");
  const iPos = idx("position");
  if ([iSeason, iRound, iPick, iName, iPos].includes(-1)) {
    throw new Error(
      `nflverse CSV missing expected columns. Got: ${header.join(", ")}`,
    );
  }

  const rows: ProspectRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const season = parseInt(cols[iSeason] ?? "", 10);
    if (season !== draftYear) continue;
    const position = (cols[iPos] ?? "").trim();
    if (!POSITIONS.has(position)) continue;
    const round = parseInt(cols[iRound] ?? "", 10);
    const pick = parseInt(cols[iPick] ?? "", 10);
    const name = (cols[iName] ?? "").trim();
    if (!name || !Number.isFinite(round) || !Number.isFinite(pick)) continue;
    // Defensive: a comma inside a player's name would break the
    // existing simple CSV format used elsewhere in this codebase.
    // None observed in nflverse, but if it ever happens the row is
    // dropped rather than written to a malformed CSV.
    if (name.includes(",")) {
      console.warn(`  Skipping name with embedded comma: ${name}`);
      continue;
    }
    rows.push({
      prospect_id: slugify(name, season),
      source: sourceName,
      draft_year: season,
      name,
      position,
      consensus_grade: gradeFromPick(pick),
      projected_round: round,
      projected_overall_pick: pick,
    });
  }
  console.log(`  ${rows.length} ${draftYear} offensive skill picks (QB/RB/WR/TE)`);
  if (rows.length === 0) {
    console.log(
      `  No picks found. Has the ${draftYear} draft happened? nflverse usually refreshes within days.`,
    );
    return;
  }

  // ── Update data/prospects.csv ──────────────────────────────────
  // Strip rows whose source is in stripSources (PYLON_SEED + the
  // target-year NFLVERSE source so re-runs don't accumulate dupes).
  // Also strip the matching comment headers so the file doesn't grow
  // a comment graveyard on each rerun.
  const csvText = fs.readFileSync(CSV_PATH, "utf8");
  const lineEnding = csvText.includes("\r\n") ? "\r\n" : "\n";
  const fileLines = csvText.split(/\r?\n/);

  const cleaned: string[] = [];
  let droppingCommentBlock = false;
  let strippedRowCount = 0;
  for (const line of fileLines) {
    const trimmed = line.trim();
    // Detect headers we want to drop. They end at the first non-#
    // non-blank line (i.e. the first data row of that block).
    if (
      trimmed.startsWith(`# ${draftYear} class — ${SEED_SOURCE_LABEL}`) ||
      trimmed.startsWith(`# ${draftYear} class — ${sourceName}`)
    ) {
      droppingCommentBlock = true;
      continue;
    }
    if (droppingCommentBlock) {
      if (trimmed.startsWith("#") || trimmed === "") continue;
      droppingCommentBlock = false;
      // fall through to evaluate this data line normally
    }
    if (trimmed.startsWith("#") || trimmed === "") {
      cleaned.push(line);
      continue;
    }
    const fields = line.split(",");
    if (stripSources.has(fields[1])) {
      strippedRowCount++;
      continue;
    }
    cleaned.push(line);
  }
  // Trim trailing blank lines so the appended block has predictable
  // spacing.
  while (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === "") {
    cleaned.pop();
  }

  const block: string[] = [
    "",
    `# ${draftYear} class — ${sourceName} — actual draft results from nflverse.`,
    `# Auto-generated by scripts/sync-nflverse-draft.ts. Re-run any time after`,
    `# the draft (nflverse usually refreshes within a few days) to rebuild.`,
    `# Replaces any prior PYLON_SEED rows for this year.`,
    ...rows.map(
      (r) =>
        `${r.prospect_id},${r.source},${r.draft_year},${r.name},${r.position},${r.consensus_grade},${r.projected_round},${r.projected_overall_pick}`,
    ),
  ];
  const newCsv = [...cleaned, ...block, ""].join(lineEnding);
  fs.writeFileSync(CSV_PATH, newCsv);
  console.log(
    `  Wrote ${path.basename(CSV_PATH)} (+${rows.length} new rows, -${strippedRowCount} stripped)`,
  );

  // ── Sync prospects table ───────────────────────────────────────
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  console.log(
    `  Deleting [${[...stripSources].join(", ")}] rows for draft_year=${draftYear} from prospects table...`,
  );
  const { error: delErr, count: delCount } = await sb
    .from("prospects")
    .delete({ count: "exact" })
    .in("source", [...stripSources])
    .eq("draft_year", draftYear);
  if (delErr) throw delErr;
  console.log(`    Deleted ${delCount ?? 0} rows`);

  console.log(`  Upserting ${rows.length} ${sourceName} rows...`);
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await sb
      .from("prospects")
      .upsert(chunk, { onConflict: "prospect_id,source" });
    if (error) throw error;
  }
  console.log(`    Done.`);

  console.log("");
  console.log("Next: npx tsx scripts/compute-prospect-consensus.ts");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
