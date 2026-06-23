/**
 * Sleeper-driven rookie existence sync.
 *
 * Problem: the players table is built from nflverse roster/draft data,
 * which assigns gsis_ids on its own schedule — late-round rookies can
 * be missing for days-to-weeks after the draft (no gsis → no players
 * row → no DPV snapshot → invisible in rankings, even though they're
 * already on Sleeper rosters and in rookie drafts).
 *
 * Fix: let Sleeper define rookie *existence*. prospect_consensus already
 * holds the full incoming class (names + actual draft round/pick from
 * the NFLVERSE_<year>_DRAFT sync). For any prospect not yet in players,
 * we look them up in Sleeper's player DB and create a players row using:
 *   - Sleeper's gsis_id if present (so stats/combine/HSM still join when
 *     they land), else
 *   - a `sleeper:<sleeper_id>` synthetic id, which matches the league-
 *     roster crosswalk's same fallback (see resolvePlayerId in sync.ts)
 *     so the rookie shows on the user's roster, not just in rankings.
 *
 * Self-correcting: once nflverse assigns the real gsis and the roster
 * ingest creates the gsis-keyed row, the cleanup pass here removes the
 * now-redundant `sleeper:`-keyed twin (and its snapshots).
 *
 * Runs in npm run refresh after compute-prospect-consensus (needs the
 * consensus rows) and before compute-dpv (which prices the new rows).
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import { CURRENT_SEASON } from "../src/lib/dpv/constants";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

const INCOMING_CLASS_YEAR = CURRENT_SEASON + 1;
const POSITIONS = new Set(["QB", "RB", "WR", "TE"]);

// Same normalization used across the pipeline (compute-dpv, sync.ts).
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Sleeper team abbreviations mostly match nflverse; the Rams differ
// (Sleeper LAR → our LA in team_seasons). Mirror the mapping used in
// sync.ts / ingest.py so the team_seasons join (OL rank, QB tier) hits.
function fixTeam(t: string | null | undefined): string | null {
  if (!t) return null;
  if (t === "LAR") return "LA";
  return t;
}

type SleeperPlayer = {
  player_id: string;
  gsis_id?: string | null;
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  position?: string | null;
  team?: string | null;
  birth_date?: string | null;
  age?: number | null;
  years_exp?: number | null;
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
  console.log(
    `Sleeper-driven rookie existence sync for ${INCOMING_CLASS_YEAR} class\n`,
  );

  // 1. Incoming-class prospects (names + actual draft round/pick).
  const prospects = await fetchAll<{
    name: string;
    position: string | null;
    projected_round: number | null;
    projected_overall_pick: number | null;
  }>(
    "prospect_consensus",
    "name,position,projected_round,projected_overall_pick",
    (q) =>
      (q as ReturnType<ReturnType<typeof sb.from>["select"]>).eq(
        "draft_year",
        INCOMING_CLASS_YEAR,
      ),
  );
  const skillProspects = prospects.filter(
    (p) => p.position && POSITIONS.has(p.position),
  );
  console.log(
    `  ${skillProspects.length} incoming-class skill prospects in consensus`,
  );

  // 2. Current players table → name+pos index (covers gsis- AND
  //    sleeper-keyed rows so we don't duplicate either).
  const players = await fetchAll<{
    player_id: string;
    name: string;
    position: string;
  }>("players", "player_id,name,position");
  const existingKey = new Set(
    players.map((p) => `${normalizeName(p.name)}|${p.position}`),
  );

  // 2b. Dedup cleanup. The same player can end up under multiple ids as
  //     better data arrives: a draft:<pick> rankings-only fallback, then
  //     a sleeper:<id> (matches rosters), then finally a real gsis once
  //     nflverse catches up. When duplicates exist for one name+position,
  //     keep the highest-priority id and remove the rest + their snapshots
  //     so the player shows once. Priority: gsis > sleeper: > draft:.
  const idPriority = (id: string): number =>
    id.startsWith("draft:") ? 2 : id.startsWith("sleeper:") ? 1 : 0;
  const byNameKey = new Map<string, typeof players>();
  for (const p of players) {
    const k = `${normalizeName(p.name)}|${p.position}`;
    const arr = byNameKey.get(k) ?? [];
    arr.push(p);
    byNameKey.set(k, arr);
  }
  const staleIds: string[] = [];
  for (const group of byNameKey.values()) {
    if (group.length < 2) continue;
    const bestPriority = Math.min(...group.map((p) => idPriority(p.player_id)));
    for (const p of group) {
      if (idPriority(p.player_id) > bestPriority) staleIds.push(p.player_id);
    }
  }
  if (staleIds.length > 0) {
    console.log(
      `  cleanup: removing ${staleIds.length} duplicate synthetic rows superseded by a higher-priority id`,
    );
    await sb.from("dpv_snapshots").delete().in("player_id", staleIds);
    await sb.from("dpv_history").delete().in("player_id", staleIds);
    await sb.from("players").delete().in("player_id", staleIds);
  }

  // 3. Which prospects are missing entirely?
  const missing = skillProspects.filter(
    (p) => !existingKey.has(`${normalizeName(p.name)}|${p.position}`),
  );
  console.log(`  ${missing.length} prospects missing from players table`);
  if (missing.length === 0) {
    console.log("Nothing to create. Done.");
    return;
  }

  // 4. Sleeper player DB → name+pos index.
  console.log("  fetching Sleeper /players/nfl ...");
  const res = await fetch("https://api.sleeper.app/v1/players/nfl");
  if (!res.ok) throw new Error(`Sleeper players fetch failed (${res.status})`);
  const sleeperPlayers = (await res.json()) as Record<string, SleeperPlayer>;
  const sleeperByKey = new Map<string, SleeperPlayer>();
  for (const sp of Object.values(sleeperPlayers)) {
    if (!sp.position || !POSITIONS.has(sp.position)) continue;
    const name =
      sp.full_name ??
      `${sp.first_name ?? ""} ${sp.last_name ?? ""}`.trim();
    if (!name) continue;
    sleeperByKey.set(`${normalizeName(name)}|${sp.position}`, sp);
  }

  // 5. Create players rows for the missing prospects we can find in Sleeper.
  type Row = {
    player_id: string;
    name: string;
    position: string;
    birthdate: string | null;
    draft_round: number | null;
    draft_year: number;
    current_team: string | null;
  };
  // Default birthdate for a class rookie (~22 at the late-April draft),
  // used when no real birth_date is available so compute-dpv's age gate
  // doesn't drop the player.
  const defaultRookieBirthdate = (): string => {
    const draftDay = Date.UTC(INCOMING_CLASS_YEAR, 3, 25);
    return new Date(draftDay - 22 * 365.25 * 86400000)
      .toISOString()
      .slice(0, 10);
  };

  const rows: Row[] = [];
  let unresolved = 0;
  let viaGsis = 0;
  let viaSleeperId = 0;
  let viaDraftFallback = 0;
  for (const pr of missing) {
    const key = `${normalizeName(pr.name)}|${pr.position}`;
    const sp = sleeperByKey.get(key);

    if (sp) {
      const gsis = sp.gsis_id?.trim();
      const playerId = gsis || `sleeper:${sp.player_id}`;
      if (gsis) viaGsis++;
      else viaSleeperId++;

      // Birthdate: Sleeper birth_date → else derive from age → else default.
      let birthdate: string | null = sp.birth_date ?? null;
      if (!birthdate) {
        const ageYears =
          typeof sp.age === "number" && sp.age > 0 ? sp.age : 22;
        const draftDay = Date.UTC(INCOMING_CLASS_YEAR, 3, 25);
        birthdate = new Date(draftDay - ageYears * 365.25 * 86400000)
          .toISOString()
          .slice(0, 10);
      }

      rows.push({
        player_id: playerId,
        name: pr.name,
        position: pr.position!,
        birthdate,
        draft_round: pr.projected_round,
        draft_year: INCOMING_CLASS_YEAR,
        current_team: fixTeam(sp.team),
      });
      continue;
    }

    // Not found in Sleeper (name mismatch, or not yet added). For a
    // genuinely drafted prospect we still have an overall pick from the
    // NFLVERSE draft sync — create a draft:<year>:<pick> row so they
    // appear in rankings with a pick-precise prior. Rankings-only: no
    // team (neutral landing spot) and won't match league rosters until a
    // Sleeper or gsis row supersedes it (the dedup pass retires this
    // then). compute-dpv's consensus name→pick fallback gives it pick
    // precision. Skip only when there's no pick to key on.
    const pick = pr.projected_overall_pick;
    if (pick === null || pick === undefined) {
      unresolved++;
      continue;
    }
    rows.push({
      player_id: `draft:${INCOMING_CLASS_YEAR}:${pick}`,
      name: pr.name,
      position: pr.position!,
      birthdate: defaultRookieBirthdate(),
      draft_round: pr.projected_round,
      draft_year: INCOMING_CLASS_YEAR,
      current_team: null,
    });
    viaDraftFallback++;
  }

  console.log(
    `  resolved ${rows.length} (${viaGsis} via Sleeper gsis, ${viaSleeperId} via sleeper:id, ${viaDraftFallback} via draft:pick fallback), ${unresolved} unresolvable (no pick)`,
  );

  if (rows.length > 0) {
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const { error } = await sb
        .from("players")
        .upsert(chunk, { onConflict: "player_id" });
      if (error) throw error;
    }
    console.log(`  upserted ${rows.length} players rows`);
  }

  console.log("\nNext: compute-dpv will price these on the next run.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
