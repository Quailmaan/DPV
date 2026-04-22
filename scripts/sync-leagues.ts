import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import { syncSleeperLeague } from "../src/lib/sleeper/sync";

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await sb
    .from("leagues")
    .select("league_id, name")
    .order("synced_at", { ascending: true });
  if (error) throw error;

  const leagues = data ?? [];
  console.log(`Re-syncing ${leagues.length} leagues...`);

  let ok = 0;
  let failed = 0;
  for (const l of leagues) {
    try {
      const r = await syncSleeperLeague(l.league_id);
      console.log(
        `  ✓ ${l.name} — ${r.rostersSynced} rosters, ${r.playersMapped} mapped`,
      );
      ok++;
    } catch (e) {
      console.error(
        `  ✗ ${l.name} (${l.league_id}):`,
        e instanceof Error ? e.message : e,
      );
      failed++;
    }
  }
  console.log(`Done. ${ok} succeeded, ${failed} failed.`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
