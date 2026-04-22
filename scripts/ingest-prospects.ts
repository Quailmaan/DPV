import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

// Ingest a CSV of consensus prospect rankings into public.prospects.
//
// CSV header (first row, case-insensitive; extra columns ignored):
//   prospect_id,draft_year,name,position,consensus_grade,projected_round,projected_overall_pick,source
//
// prospect_id should be stable across ingestion runs (e.g. slugified name).
// Rows with the same prospect_id upsert; stale rows for a draft_year are NOT
// deleted automatically — use a fresh source tag per ingestion if you want
// to replace a year's data wholesale.
//
// Usage: npx tsx scripts/ingest-prospects.ts <path-to-csv>

type ProspectRow = {
  prospect_id: string;
  draft_year: number;
  name: string;
  position: "QB" | "RB" | "WR" | "TE" | null;
  consensus_grade: number | null;
  projected_round: number | null;
  projected_overall_pick: number | null;
  source: string | null;
};

function parseCsv(text: string): ProspectRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iId = idx("prospect_id");
  const iYear = idx("draft_year");
  const iName = idx("name");
  const iPos = idx("position");
  const iGrade = idx("consensus_grade");
  const iRound = idx("projected_round");
  const iPick = idx("projected_overall_pick");
  const iSource = idx("source");

  const required = [
    ["prospect_id", iId],
    ["draft_year", iYear],
    ["name", iName],
  ] as const;
  for (const [label, n] of required) {
    if (n < 0) throw new Error(`CSV missing required column: ${label}`);
  }

  const rows: ProspectRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",").map((c) => c.trim());
    const year = Number(cols[iYear]);
    if (!Number.isFinite(year)) continue;
    const pos = iPos >= 0 ? cols[iPos].toUpperCase() : "";
    const allowed = ["QB", "RB", "WR", "TE"];
    rows.push({
      prospect_id: cols[iId],
      draft_year: year,
      name: cols[iName],
      position: allowed.includes(pos)
        ? (pos as ProspectRow["position"])
        : null,
      consensus_grade:
        iGrade >= 0 && cols[iGrade] ? Number(cols[iGrade]) : null,
      projected_round:
        iRound >= 0 && cols[iRound] ? Number(cols[iRound]) : null,
      projected_overall_pick:
        iPick >= 0 && cols[iPick] ? Number(cols[iPick]) : null,
      source: iSource >= 0 && cols[iSource] ? cols[iSource] : null,
    });
  }
  return rows;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error(
      "Usage: npx tsx scripts/ingest-prospects.ts <path-to-csv>",
    );
    process.exit(1);
  }
  const abs = path.resolve(csvPath);
  if (!fs.existsSync(abs)) {
    console.error(`CSV not found: ${abs}`);
    process.exit(1);
  }
  const rows = parseCsv(fs.readFileSync(abs, "utf8"));
  console.log(`Parsed ${rows.length} prospects from ${path.basename(abs)}`);
  if (rows.length === 0) {
    console.log("Nothing to ingest.");
    return;
  }

  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map((r) => ({
      ...r,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await sb
      .from("prospects")
      .upsert(chunk, { onConflict: "prospect_id" });
    if (error) throw error;
  }
  console.log(`Upserted ${rows.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
