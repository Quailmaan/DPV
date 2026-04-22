import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { syncSleeperLeague } from "../src/lib/sleeper/sync";

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: npx tsx scripts/sync-league.ts <league_id>");
    process.exit(1);
  }
  console.log(`Syncing Sleeper league ${id}...`);
  const result = await syncSleeperLeague(id);
  console.log("✓ synced");
  console.log(`  league: ${result.name} (${result.season})`);
  console.log(`  format: ${result.scoringFormat}`);
  console.log(`  rosters: ${result.rostersSynced}/${result.totalRosters}`);
  console.log(
    `  players mapped: ${result.playersMapped}, unmapped: ${result.playersUnmapped}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
