import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

// Pulls nflverse's draft_picks release and backfills players.draft_round and
// players.draft_year for everyone matched on gsis_id. Safe to run repeatedly:
// only updates rows where the value would actually change.
//
// Release URL pattern:
//   https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv
//
// Schema (subset we care about): season, round, pick, gsis_id, pfr_player_id,
// full_name, position.

const CSV_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv";

type DraftRow = {
  season: number;
  round: number;
  pick: number | null;
  gsis_id: string | null;
  pfr_id: string | null;
  name: string;
  position: string | null;
};

function parseCsv(text: string): DraftRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0]
    .split(",")
    .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const col = (name: string) => header.indexOf(name);

  const iSeason = col("season");
  const iRound = col("round");
  const iPick = col("pick");
  const iGsis = col("gsis_id");
  const iPfr = col("pfr_player_id");
  const iName = col("pfr_player_name");
  const iNameFallback = col("full_name");
  const iPos = col("position");

  if (iSeason < 0 || iRound < 0) {
    throw new Error(
      `draft_picks.csv missing season/round columns. Saw: ${header.join(",")}`,
    );
  }

  const rows: DraftRow[] = [];
  for (const line of lines.slice(1)) {
    // Lightweight CSV split: nflverse draft_picks doesn't use quoted commas.
    const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
    const season = Number(cols[iSeason]);
    const round = Number(cols[iRound]);
    if (!Number.isFinite(season) || !Number.isFinite(round)) continue;
    const gsis = iGsis >= 0 ? cols[iGsis] || null : null;
    const pfr = iPfr >= 0 ? cols[iPfr] || null : null;
    const nameCol = iName >= 0 ? iName : iNameFallback;
    rows.push({
      season,
      round,
      pick: iPick >= 0 && cols[iPick] ? Number(cols[iPick]) : null,
      gsis_id: gsis && gsis !== "NA" ? gsis : null,
      pfr_id: pfr && pfr !== "NA" ? pfr : null,
      name: nameCol >= 0 ? cols[nameCol] : "",
      position: iPos >= 0 ? cols[iPos] || null : null,
    });
  }
  return rows;
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  console.log(`Fetching draft_picks from nflverse...`);
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`nflverse fetch failed: ${res.status}`);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  console.log(`  parsed ${rows.length} draft picks`);

  // Build gsis → (round, year) map. Prefer the earliest season per gsis_id
  // (original draft year, not re-draft years for supplemental picks).
  const byGsis = new Map<string, { round: number; year: number }>();
  for (const r of rows) {
    if (!r.gsis_id) continue;
    const existing = byGsis.get(r.gsis_id);
    if (!existing || r.season < existing.year) {
      byGsis.set(r.gsis_id, { round: r.round, year: r.season });
    }
  }
  console.log(`  ${byGsis.size} gsis_id → draft capital mappings`);

  console.log("Loading existing players...");
  const PAGE = 1000;
  type Player = {
    player_id: string;
    name: string;
    draft_round: number | null;
    draft_year: number | null;
  };
  const players: Player[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from("players")
      .select("player_id, name, draft_round, draft_year")
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    players.push(...(data as Player[]));
    if (data.length < PAGE) break;
  }
  console.log(`  ${players.length} players`);

  type Update = {
    player_id: string;
    draft_round: number;
    draft_year: number;
    name: string;
    prev: { round: number | null; year: number | null };
  };
  const updates: Update[] = [];
  let matched = 0;
  let unmatched = 0;
  for (const p of players) {
    const hit = byGsis.get(p.player_id);
    if (!hit) {
      unmatched++;
      continue;
    }
    matched++;
    if (p.draft_round === hit.round && p.draft_year === hit.year) continue;
    updates.push({
      player_id: p.player_id,
      draft_round: hit.round,
      draft_year: hit.year,
      name: p.name,
      prev: { round: p.draft_round, year: p.draft_year },
    });
  }
  console.log(
    `  matched: ${matched}, unmatched: ${unmatched}, changes to apply: ${updates.length}`,
  );
  if (updates.length > 0) {
    console.log("  sample changes:");
    for (const u of updates.slice(0, 15)) {
      console.log(
        `    ${u.name}: R${u.prev.round ?? "?"}/${u.prev.year ?? "?"} → R${u.draft_round}/${u.draft_year}`,
      );
    }
  }

  let applied = 0;
  for (const u of updates) {
    const { error } = await sb
      .from("players")
      .update({
        draft_round: u.draft_round,
        draft_year: u.draft_year,
        updated_at: new Date().toISOString(),
      })
      .eq("player_id", u.player_id);
    if (error) {
      console.error(`Update error for ${u.player_id}:`, error.message);
      continue;
    }
    applied++;
  }
  console.log(`Done. Applied ${applied}/${updates.length} draft-capital updates.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
