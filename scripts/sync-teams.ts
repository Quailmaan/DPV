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

type ExistingPlayer = {
  current_team: string | null;
  name: string;
  position: string;
};

async function fetchExistingPlayers(): Promise<Map<string, ExistingPlayer>> {
  const byId = new Map<string, ExistingPlayer>();
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from("players")
      .select("player_id, name, position, current_team")
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const row of data) {
      byId.set(row.player_id, {
        current_team: row.current_team,
        name: row.name,
        position: row.position,
      });
    }
    if (data.length < PAGE) break;
  }
  return byId;
}

// Build a name+position → gsis_id lookup. Only unique matches get returned
// so we never update the wrong "Tyler Johnson" when there are two.
function buildNameIndex(
  existing: Map<string, ExistingPlayer>,
): Map<string, string | null> {
  const counts = new Map<string, number>();
  const firstId = new Map<string, string>();
  const key = (name: string, pos: string) =>
    `${name.toLowerCase().trim()}|${pos.toUpperCase()}`;
  for (const [id, p] of existing) {
    if (!p.name || !p.position) continue;
    const k = key(p.name, p.position);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!firstId.has(k)) firstId.set(k, id);
  }
  const index = new Map<string, string | null>();
  for (const [k, n] of counts) {
    index.set(k, n === 1 ? firstId.get(k)! : null); // null = ambiguous
  }
  return index;
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
  const nameIndex = buildNameIndex(existing);
  console.log(`  ${existing.size} in DB`);

  // Sleeper's team abbreviations differ from nflverse in one spot: LAR vs LA.
  const normalizeTeam = (t: string): string => (t === "LAR" ? "LA" : t);
  const nameKey = (name: string, pos: string) =>
    `${name.toLowerCase().trim()}|${pos.toUpperCase()}`;

  const updates: Array<{ player_id: string; current_team: string }> = [];
  const changes: Array<{ name: string; from: string | null; to: string; via: string }> = [];
  let skippedAmbiguous = 0;
  let skippedUnknown = 0;
  for (const p of Object.values(players)) {
    // Only track players Sleeper considers Active AND on a team. Skip nulls
    // to preserve "last known team" for retired/inactive players.
    if (p.status !== "Active") continue;
    if (!p.team) continue;
    if (!p.full_name || !p.position) continue;

    // Primary: match on gsis_id when Sleeper has it (some records don't).
    const gsis = p.gsis_id?.trim();
    let playerId: string | null = null;
    let via = "gsis";
    if (gsis && existing.has(gsis)) {
      playerId = gsis;
    } else {
      // Fallback: match on (name, position). Only accept unique matches so
      // two "Tyler Johnson"s don't cross-contaminate.
      const k = nameKey(p.full_name, p.position);
      const hit = nameIndex.get(k);
      if (hit === null) {
        skippedAmbiguous++;
        continue;
      }
      if (hit === undefined) {
        skippedUnknown++;
        continue;
      }
      playerId = hit;
      via = "name";
    }

    const newTeam = normalizeTeam(p.team);
    const oldTeam = existing.get(playerId)?.current_team ?? null;
    if (newTeam === oldTeam) continue;
    updates.push({ player_id: playerId, current_team: newTeam });
    if (changes.length < 40) {
      changes.push({ name: p.full_name, from: oldTeam, to: newTeam, via });
    }
  }
  console.log(
    `  skipped: ${skippedAmbiguous} ambiguous name+pos, ${skippedUnknown} not in DB`,
  );
  console.log(`  ${updates.length} team changes to apply`);
  if (changes.length) {
    console.log("  sample changes:");
    for (const c of changes) {
      console.log(`    ${c.name}: ${c.from ?? "FA"} → ${c.to ?? "FA"} (via ${c.via})`);
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
