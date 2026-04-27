// Quick post-draft sanity check: how many 2026-drafted rookies have we
// actually got in the players table with draft capital populated, and how
// many show up in dpv_snapshots via the rookie prior?

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

async function main() {
  const { data: drafted, error: e1 } = await sb
    .from("players")
    .select("player_id, name, position, current_team, draft_round, draft_year")
    .eq("draft_year", 2026)
    .order("draft_round", { ascending: true })
    .order("name", { ascending: true });

  if (e1) {
    console.error("players query failed:", e1);
    process.exit(1);
  }

  const rows = drafted ?? [];
  console.log(`Players with draft_year=2026: ${rows.length}`);

  const byPos: Record<string, number> = {};
  const byRound: Record<number, number> = {};
  for (const p of rows) {
    byPos[p.position] = (byPos[p.position] ?? 0) + 1;
    if (p.draft_round !== null)
      byRound[p.draft_round] = (byRound[p.draft_round] ?? 0) + 1;
  }
  console.log("by position:", byPos);
  console.log("by round:", byRound);

  // How many landed in DPV snapshots (rookie prior or consensus)?
  const ids = rows.map((r) => r.player_id);
  if (ids.length === 0) {
    console.log("\n(No 2026 rookies in players table yet.)");
    return;
  }

  const { data: snaps } = await sb
    .from("dpv_snapshots")
    .select("player_id, dpv, scoring_format")
    .in("player_id", ids)
    .eq("scoring_format", "HALF_PPR");

  const snapIds = new Set((snaps ?? []).map((s) => s.player_id));
  const priced = rows.filter((r) => snapIds.has(r.player_id));
  const missing = rows.filter((r) => !snapIds.has(r.player_id));

  console.log(`\nPriced in HALF_PPR snapshots: ${priced.length} / ${rows.length}`);
  if (missing.length > 0) {
    console.log("First 10 unpriced:");
    for (const m of missing.slice(0, 10)) {
      console.log(
        `  ${m.name} (${m.position}, R${m.draft_round ?? "?"}, ${m.current_team ?? "—"})`,
      );
    }
  }

  // Top 10 priced rookies for vibe check
  console.log("\nTop 10 priced 2026 rookies:");
  const dpvMap = new Map((snaps ?? []).map((s) => [s.player_id, s.dpv]));
  const top = priced
    .map((r) => ({ ...r, dpv: dpvMap.get(r.player_id) ?? 0 }))
    .sort((a, b) => b.dpv - a.dpv)
    .slice(0, 10);
  for (const r of top) {
    console.log(
      `  ${r.dpv.toString().padStart(5)} ${r.name} (${r.position}) R${r.draft_round ?? "?"} ${r.current_team ?? "—"}`,
    );
  }
}

main();
