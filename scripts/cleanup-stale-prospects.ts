/**
 * Purge orphaned prospect rows that linger in the database after they've
 * been removed from data/prospects.csv.
 *
 * Why this is needed: ingest-prospects UPSERTS from the CSV (it never
 * deletes), so rows from a retired source — e.g. the early speculative
 * PYLON_SEED, or a player who turned out to be a future-class prospect
 * and got removed — stay in the `prospects` table forever, get
 * re-aggregated into `prospect_consensus`, and show up on the rookies
 * page as stale "proj" entries (this is exactly why Justice Haynes /
 * Caden Durham appeared as 2026 projections they never belonged to).
 *
 * The CSV is the source of truth. This script:
 *   1. Deletes `prospects` rows whose (prospect_id, source) isn't in the CSV.
 *   2. Deletes `prospect_consensus` rows whose prospect_id no longer has
 *      any backing `prospects` row.
 *
 * Safe to re-run. Run after editing the CSV, then re-run
 * compute-prospect-consensus to refresh grades. Wired into the nightly
 * refresh before compute-prospect-consensus.
 *
 *   npx tsx scripts/cleanup-stale-prospects.ts
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

const CSV_PATH = path.join(process.cwd(), "data", "prospects.csv");

async function fetchAll<T>(table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    const { data, error } = await sb
      .from(table)
      .select(columns)
      .range(start, start + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

async function deleteInChunks(
  table: string,
  ids: string[],
  column = "player_id",
) {
  const BATCH = 200; // keep the .in() URL well under length limits
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const { error } = await sb.from(table).delete().in(column, chunk);
    if (error) throw error;
  }
}

async function main() {
  console.log("Cleaning stale prospects against data/prospects.csv\n");

  // 1. Parse the CSV → valid (prospect_id|source) keys + valid prospect_ids.
  const text = fs.readFileSync(CSV_PATH, "utf8");
  const lines = text.split(/\r?\n/);
  const validKeys = new Set<string>();
  const validProspectIds = new Set<string>();
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const fields = t.split(",");
    // Skip the header row.
    if (fields[0] === "prospect_id") continue;
    const prospectId = fields[0];
    const source = fields[1];
    if (!prospectId || !source) continue;
    validKeys.add(`${prospectId}|${source}`);
    validProspectIds.add(prospectId);
  }
  console.log(
    `  CSV: ${validKeys.size} (prospect_id, source) rows, ${validProspectIds.size} distinct prospects`,
  );

  // 2. prospects table → delete rows not in the CSV.
  const prospects = await fetchAll<{ prospect_id: string; source: string }>(
    "prospects",
    "prospect_id,source",
  );
  const staleProspects = prospects.filter(
    (p) => !validKeys.has(`${p.prospect_id}|${p.source}`),
  );
  console.log(
    `  prospects table: ${prospects.length} rows, ${staleProspects.length} stale (not in CSV)`,
  );
  if (staleProspects.length > 0) {
    // prospects PK is (prospect_id, source); delete by prospect_id in
    // chunks, then we re-derive which consensus rows are orphaned below.
    // A few sources can share a prospect_id, so deleting by prospect_id
    // could over-delete — instead delete each stale (id, source) pair.
    const BATCH = 100;
    for (let i = 0; i < staleProspects.length; i += BATCH) {
      const chunk = staleProspects.slice(i, i + BATCH);
      // Supabase has no native composite-key .in(); delete per-source
      // groups filtered by the ids in that source.
      const bySource = new Map<string, string[]>();
      for (const p of chunk) {
        const arr = bySource.get(p.source) ?? [];
        arr.push(p.prospect_id);
        bySource.set(p.source, arr);
      }
      for (const [source, ids] of bySource) {
        const { error } = await sb
          .from("prospects")
          .delete()
          .eq("source", source)
          .in("prospect_id", ids);
        if (error) throw error;
      }
    }
    console.log(`    deleted ${staleProspects.length} stale prospects rows`);
  }

  // 3. prospect_consensus → delete rows whose prospect_id no longer has
  //    any backing prospects row in the CSV.
  const consensus = await fetchAll<{ prospect_id: string }>(
    "prospect_consensus",
    "prospect_id",
  );
  const staleConsensus = consensus
    .filter((c) => !validProspectIds.has(c.prospect_id))
    .map((c) => c.prospect_id);
  console.log(
    `  prospect_consensus: ${consensus.length} rows, ${staleConsensus.length} stale`,
  );
  if (staleConsensus.length > 0) {
    await deleteInChunks("prospect_consensus", staleConsensus, "prospect_id");
    console.log(`    deleted ${staleConsensus.length} stale consensus rows`);
  }

  console.log("\nDone. Re-run compute-prospect-consensus to refresh grades.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
