/**
 * Reconcile duplicate player rows — the same person under multiple ids.
 *
 * Over the project's life a single player can pick up more than one
 * players row: a real nflverse gsis (00-00xxxxx), a sync-rookie-existence
 * synthetic (sleeper:<id> / draft:<year>:<pick>), and legacy ids from the
 * early speculative seed (e.g. HIB564972). When two rows for one player
 * coexist they cause two bugs:
 *   1. The player shows TWICE in rankings (two dpv_snapshots).
 *   2. The league-roster name resolver (resolvePlayerId) sees two
 *      candidates, calls it ambiguous, and falls back to a sleeper:<id>
 *      that matches no snapshot — so the player vanishes from the roster
 *      view even though he's rostered.
 *
 * This collapses each (normalized name, position) group to ONE row:
 *   - Canonical id by priority: real gsis > sleeper:<id> > draft:<pick> >
 *     legacy. We keep the gsis because that's what roster syncs resolve
 *     to once Sleeper exposes it, so roster + snapshot stay aligned.
 *   - The canonical row's null fields (birthdate, draft_round, draft_year,
 *     current_team) are backfilled from the duplicates — so we keep the
 *     real id AND the most complete data (the seed row's birthdate/round
 *     fills the gsis row's gaps).
 *   - The non-canonical rows + their dpv_snapshots/dpv_history are deleted.
 *
 * Safety: only merges rows that agree on draft_year (or where a row's
 * draft_year is null), so two genuinely different players who share a
 * name+position (rare) aren't fused.
 *
 * Idempotent. Wired into the nightly refresh before compute-dpv; run
 * manually then re-run compute-dpv + re-sync leagues to apply now.
 *
 *   npx tsx scripts/dedup-players.ts
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

type Player = {
  player_id: string;
  name: string;
  position: string;
  birthdate: string | null;
  draft_round: number | null;
  draft_year: number | null;
  current_team: string | null;
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Lower = more canonical. Real gsis wins; legacy seed ids lose.
function idPriority(id: string): number {
  if (/^\d{2}-\d{6,}$/.test(id)) return 0; // gsis (00-00xxxxx)
  if (id.startsWith("sleeper:")) return 1;
  if (id.startsWith("draft:")) return 2;
  return 3; // legacy / unknown (e.g. HIB564972)
}

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

async function deleteInChunks(table: string, ids: string[]) {
  const BATCH = 100;
  for (let i = 0; i < ids.length; i += BATCH) {
    const { error } = await sb
      .from(table)
      .delete()
      .in("player_id", ids.slice(i, i + BATCH));
    if (error) throw error;
  }
}

async function main() {
  console.log("Reconciling duplicate player rows\n");

  const players = await fetchAll<Player>(
    "players",
    "player_id,name,position,birthdate,draft_round,draft_year,current_team",
  );

  // Group by normalized name + position.
  const groups = new Map<string, Player[]>();
  for (const p of players) {
    const key = `${normalizeName(p.name)}|${p.position}`;
    const arr = groups.get(key) ?? [];
    arr.push(p);
    groups.set(key, arr);
  }

  const toDelete: string[] = [];
  let merged = 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;

    // Split into draft-year-compatible clusters so two different players
    // with the same name aren't fused. Rows with null draft_year attach
    // to whichever non-null cluster exists (most common: a synthetic row
    // missing draft_year alongside the real one).
    const years = [
      ...new Set(group.map((p) => p.draft_year).filter((y) => y !== null)),
    ];
    if (years.length > 1) {
      // Genuinely distinct players (different draft years) — leave alone.
      continue;
    }

    // One logical player. Pick the canonical id, backfill its gaps.
    const sorted = [...group].sort(
      (a, b) => idPriority(a.player_id) - idPriority(b.player_id),
    );
    const canonical = sorted[0];
    const dups = sorted.slice(1);

    const pick = <K extends keyof Player>(field: K): Player[K] => {
      if (canonical[field] !== null && canonical[field] !== undefined)
        return canonical[field];
      for (const d of dups) {
        if (d[field] !== null && d[field] !== undefined) return d[field];
      }
      return canonical[field];
    };

    const mergedRow = {
      birthdate: pick("birthdate"),
      draft_round: pick("draft_round"),
      draft_year: pick("draft_year"),
      current_team: pick("current_team"),
    };

    // Only write if the merge actually changed something.
    const changed =
      mergedRow.birthdate !== canonical.birthdate ||
      mergedRow.draft_round !== canonical.draft_round ||
      mergedRow.draft_year !== canonical.draft_year ||
      mergedRow.current_team !== canonical.current_team;
    if (changed) {
      const { error } = await sb
        .from("players")
        .update(mergedRow)
        .eq("player_id", canonical.player_id);
      if (error) throw error;
    }

    console.log(
      `  ${canonical.name} (${canonical.position}): keep ${canonical.player_id}${changed ? " (backfilled)" : ""}, drop ${dups.map((d) => d.player_id).join(", ")}`,
    );
    toDelete.push(...dups.map((d) => d.player_id));
    merged++;
  }

  if (toDelete.length > 0) {
    console.log(
      `\nDeleting ${toDelete.length} duplicate rows + their snapshots/history...`,
    );
    await deleteInChunks("dpv_snapshots", toDelete);
    await deleteInChunks("dpv_history", toDelete);
    await deleteInChunks("players", toDelete);
  }

  console.log(
    `\nDone. Reconciled ${merged} duplicate groups (${toDelete.length} rows removed).`,
  );
  if (merged > 0) {
    console.log("Re-run compute-dpv, and re-sync leagues so rosters re-resolve.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
