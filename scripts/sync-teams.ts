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

interface SleeperPlayer {
  player_id: string;
  gsis_id?: string | null;
  team?: string | null;
  full_name?: string;
  status?: string;
  position?: string;
}

async function fetchExistingPlayers(): Promise<Map<string, string | null>> {
  const byId = new Map<string, string | null>();
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from("players")
      .select("player_id, current_team")
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) byId.set(row.player_id, row.current_team);
    if (data.length < PAGE) break;
  }
  return byId;
}

async function main() {
  console.log("Fetching Sleeper NFL roster...");
  const res = await fetch("https://api.sleeper.app/v1/players/nfl");
  if (!res.ok) {
    console.error(`Sleeper API error: ${res.status}`);
    process.exit(1);
  }
  const players = (await res.json()) as Record<string, SleeperPlayer>;
  console.log(`  ${Object.keys(players).length} Sleeper records`);

  console.log("Fetching existing players...");
  const existing = await fetchExistingPlayers();
  console.log(`  ${existing.size} in DB`);

  // Sleeper's team abbreviations differ from nflverse in one spot: LAR vs LA.
  const normalizeTeam = (t: string): string => (t === "LAR" ? "LA" : t);

  const updates: Array<{ player_id: string; current_team: string }> = [];
  const changes: Array<{ name: string; from: string | null; to: string }> = [];
  for (const p of Object.values(players)) {
    // Some Sleeper records have leading/trailing whitespace on gsis_id.
    const gsis = p.gsis_id?.trim();
    if (!gsis) continue;
    if (!existing.has(gsis)) continue;
    // Only track players Sleeper considers Active AND on a team. Skip nulls
    // to preserve "last known team" for retired/inactive players.
    if (p.status !== "Active") continue;
    if (!p.team) continue;
    const newTeam = normalizeTeam(p.team);
    const oldTeam = existing.get(gsis) ?? null;
    if (newTeam === oldTeam) continue;
    updates.push({ player_id: gsis, current_team: newTeam });
    if (changes.length < 40 && p.full_name) {
      changes.push({ name: p.full_name, from: oldTeam, to: newTeam });
    }
  }
  console.log(`  ${updates.length} team changes to apply`);
  if (changes.length) {
    console.log("  sample changes:");
    for (const c of changes) {
      console.log(`    ${c.name}: ${c.from ?? "FA"} → ${c.to ?? "FA"}`);
    }
  }

  // Per-row UPDATE (not upsert): PostgREST upsert checks NOT NULL before
  // ON CONFLICT, so omitting required columns fails even on rows that exist.
  let applied = 0;
  for (const u of updates) {
    const { error } = await sb
      .from("players")
      .update({ current_team: u.current_team, updated_at: new Date().toISOString() })
      .eq("player_id", u.player_id);
    if (error) {
      console.error(`Update error for ${u.player_id}:`, error.message);
      continue;
    }
    applied++;
  }
  console.log(`Done. Applied ${applied}/${updates.length} team updates.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
