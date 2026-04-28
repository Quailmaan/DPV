import { createClient } from "@supabase/supabase-js";
import { currentPickWindow } from "@/lib/picks/constants";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SECRET_KEY).",
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

type SleeperLeague = {
  league_id: string;
  name: string;
  season: string;
  total_rosters: number;
  scoring_settings?: Record<string, number>;
  settings?: Record<string, number>;
  // Slot list, e.g. ["QB","RB","RB","WR","WR","WR","TE","FLEX","SUPER_FLEX",
  // "BN","BN",...]. We persist this so the trade calculator can shape
  // position scarcity per league (SF inflates QB, 3WR/2RB+FLEX inflates skill).
  roster_positions?: string[];
};

type SleeperUser = {
  user_id: string;
  display_name: string;
  metadata?: { team_name?: string };
};

type SleeperRoster = {
  roster_id: number;
  owner_id: string | null;
  players: string[] | null;
};

// Sleeper's traded_picks endpoint returns one row per pick that has changed
// hands. Untraded picks don't appear and are synthesized from the rosters
// list. `roster_id` is the team whose draft slot this is (i.e. the original
// owner); `owner_id` is the current holder after any chain of trades.
type SleeperTradedPick = {
  season: string;
  round: number;
  roster_id: number;
  previous_owner_id: number | null;
  owner_id: number;
};

type SleeperPlayer = {
  player_id: string;
  gsis_id?: string | null;
  full_name?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  team?: string;
};

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.'`’-]/g, "")
    .replace(/\s+(jr|sr|ii|iii|iv|v)\.?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function detectFormat(
  scoring: Record<string, number> | undefined,
): "STANDARD" | "HALF_PPR" | "FULL_PPR" {
  const rec = scoring?.rec ?? 0;
  if (rec >= 0.9) return "FULL_PPR";
  if (rec >= 0.4) return "HALF_PPR";
  return "STANDARD";
}

export type SyncResult = {
  leagueId: string;
  name: string;
  season: string;
  totalRosters: number;
  scoringFormat: "STANDARD" | "HALF_PPR" | "FULL_PPR";
  rostersSynced: number;
  playersMapped: number;
  playersUnmapped: number;
  picksSynced: number;
};

export async function syncSleeperLeague(
  leagueId: string,
): Promise<SyncResult> {
  const id = leagueId.trim();
  if (!/^\d+$/.test(id)) {
    throw new Error("League ID must be a numeric Sleeper ID.");
  }

  const [leagueRes, usersRes, rostersRes, tradedPicksRes] = await Promise.all([
    fetch(`https://api.sleeper.app/v1/league/${id}`),
    fetch(`https://api.sleeper.app/v1/league/${id}/users`),
    fetch(`https://api.sleeper.app/v1/league/${id}/rosters`),
    fetch(`https://api.sleeper.app/v1/league/${id}/traded_picks`),
  ]);

  if (!leagueRes.ok) {
    throw new Error(
      `Sleeper league fetch failed (${leagueRes.status}). Check the league ID.`,
    );
  }

  const league = (await leagueRes.json()) as SleeperLeague | null;
  if (!league || !league.league_id) {
    throw new Error("League not found on Sleeper.");
  }
  const users = (await usersRes.json()) as SleeperUser[];
  const rosters = (await rostersRes.json()) as SleeperRoster[];
  // traded_picks may 404 or fail intermittently; treat as empty rather than
  // failing the whole sync. Untraded picks are synthesized regardless.
  const tradedPicks: SleeperTradedPick[] = tradedPicksRes.ok
    ? ((await tradedPicksRes.json()) as SleeperTradedPick[]) ?? []
    : [];

  // Build sleeper_id → gsis_id map by fetching the full Sleeper player set.
  const playersRes = await fetch("https://api.sleeper.app/v1/players/nfl");
  if (!playersRes.ok) {
    throw new Error("Could not fetch Sleeper player map.");
  }
  const sleeperPlayers = (await playersRes.json()) as Record<
    string,
    SleeperPlayer
  >;
  const sleeperToGsis = new Map<string, string>();
  for (const p of Object.values(sleeperPlayers)) {
    const gsis = p.gsis_id?.trim();
    if (gsis) sleeperToGsis.set(p.player_id, gsis);
  }

  // Fallback: Sleeper's gsis_id field is missing for many current stars
  // (Chase, Jordan Love, Caleb Williams, etc.). Build a name+position index
  // over our own players so we can match by name when gsis is absent.
  const sb = adminClient();
  const nameIndex = new Map<string, string[]>();
  const dbNameIndex = new Map<string, string>();
  {
    const PAGE = 1000;
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await sb
        .from("players")
        .select("player_id, name, position, current_team")
        .range(start, start + PAGE - 1);
      if (error) throw new Error(`Players load: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const row of data) {
        const key = `${normalizeName(row.name)}|${row.position}`;
        const arr = nameIndex.get(key) ?? [];
        arr.push(row.player_id);
        nameIndex.set(key, arr);
        // Team-qualified key for tiebreaking when multiple match.
        if (row.current_team) {
          dbNameIndex.set(
            `${normalizeName(row.name)}|${row.position}|${row.current_team}`,
            row.player_id,
          );
        }
      }
      if (data.length < PAGE) break;
    }
  }

  function resolvePlayerId(sid: string): string | null {
    const direct = sleeperToGsis.get(sid);
    if (direct) return direct;
    const sp = sleeperPlayers[sid];
    if (!sp || !sp.position) return null;
    if (!["QB", "RB", "WR", "TE"].includes(sp.position)) return null;
    const name =
      sp.full_name ??
      `${sp.first_name ?? ""} ${sp.last_name ?? ""}`.trim();
    if (!name) return null;
    const key = `${normalizeName(name)}|${sp.position}`;
    // Team-qualified lookup first.
    if (sp.team) {
      const teamKey = `${key}|${sp.team === "LAR" ? "LA" : sp.team}`;
      const tm = dbNameIndex.get(teamKey);
      if (tm) return tm;
    }
    const candidates = nameIndex.get(key);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];
    return null; // ambiguous — skip
  }

  const format = detectFormat(league.scoring_settings);

  // Upsert league row.
  {
    const { error } = await sb.from("leagues").upsert(
      {
        league_id: league.league_id,
        name: league.name,
        season: league.season,
        total_rosters: league.total_rosters,
        scoring_format: format,
        raw_settings: league.settings ?? null,
        roster_positions: league.roster_positions ?? null,
        synced_at: new Date().toISOString(),
      },
      { onConflict: "league_id" },
    );
    if (error) throw new Error(`Leagues upsert: ${error.message}`);
  }

  const userById = new Map<string, SleeperUser>();
  for (const u of users) userById.set(u.user_id, u);

  // Clear any stale rosters for this league before reinserting.
  {
    const { error } = await sb
      .from("league_rosters")
      .delete()
      .eq("league_id", league.league_id);
    if (error) throw new Error(`Roster clear: ${error.message}`);
  }

  let totalMapped = 0;
  let totalUnmapped = 0;
  const rows = rosters.map((r) => {
    const owner = r.owner_id ? userById.get(r.owner_id) : undefined;
    const playerIds = (r.players ?? [])
      .map((sid) => {
        const pid = resolvePlayerId(sid);
        if (pid) {
          totalMapped++;
          return pid;
        }
        totalUnmapped++;
        return null;
      })
      .filter((x): x is string => x !== null);
    return {
      league_id: league.league_id,
      roster_id: r.roster_id,
      owner_user_id: r.owner_id,
      owner_display_name: owner?.display_name ?? null,
      team_name: owner?.metadata?.team_name ?? null,
      player_ids: playerIds,
      updated_at: new Date().toISOString(),
    };
  });

  if (rows.length > 0) {
    const { error } = await sb.from("league_rosters").insert(rows);
    if (error) throw new Error(`Roster insert: ${error.message}`);
  }

  // ----------------------------------------------------------------
  // Rookie pick ownership.
  //
  // Sleeper's /traded_picks endpoint returns ONLY picks that have changed
  // hands. To get a full per-team picture we synthesize the default state
  // (each team owns their own R1/R2/R3 across the rolling 3-year window),
  // then apply the traded rows on top. owner_roster_id starts equal to
  // original_roster_id, then gets overridden where Sleeper says it should.
  //
  // Slot ordering inside a round (1.01 vs 1.05) isn't tracked here — Sleeper
  // doesn't expose it, and it's not knowable until standings finalize. The
  // trade calculator values these picks as the round-average DPV.
  // ----------------------------------------------------------------
  const [y0, y1, y2] = currentPickWindow(new Date());
  const seasonsInWindow = [y0, y1, y2];
  const rounds: Array<1 | 2 | 3> = [1, 2, 3];

  type PickRow = {
    league_id: string;
    season: number;
    round: number;
    original_roster_id: number;
    owner_roster_id: number;
    updated_at: string;
  };

  // Default: each roster owns its own picks across the window.
  const pickKey = (s: number, r: number, orig: number) => `${s}|${r}|${orig}`;
  const pickMap = new Map<string, PickRow>();
  const nowIso = new Date().toISOString();
  for (const r of rosters) {
    for (const season of seasonsInWindow) {
      for (const round of rounds) {
        pickMap.set(pickKey(season, round, r.roster_id), {
          league_id: league.league_id,
          season,
          round,
          original_roster_id: r.roster_id,
          owner_roster_id: r.roster_id,
          updated_at: nowIso,
        });
      }
    }
  }

  // Apply Sleeper's traded picks. We only care about rounds 1-3 within the
  // current window; deeper rounds and out-of-window seasons are ignored
  // (the pick valuation curve only covers R1-R3, and the window roll-forward
  // makes earlier seasons no longer tradeable as rookie picks).
  for (const tp of tradedPicks) {
    const season = Number(tp.season);
    if (!seasonsInWindow.includes(season)) continue;
    if (tp.round < 1 || tp.round > 3) continue;
    const key = pickKey(season, tp.round, tp.roster_id);
    const existing = pickMap.get(key);
    if (!existing) continue;
    existing.owner_roster_id = tp.owner_id;
  }

  // Wipe + reinsert league_picks for this league. Round-level granularity
  // means at most rosters * 3 seasons * 3 rounds rows per league (~108 for
  // a 12-team league) — well under bulk-insert limits.
  {
    const { error } = await sb
      .from("league_picks")
      .delete()
      .eq("league_id", league.league_id);
    if (error) throw new Error(`Picks clear: ${error.message}`);
  }
  const pickRows = Array.from(pickMap.values());
  if (pickRows.length > 0) {
    const { error } = await sb.from("league_picks").insert(pickRows);
    if (error) throw new Error(`Picks insert: ${error.message}`);
  }

  return {
    leagueId: league.league_id,
    name: league.name,
    season: league.season,
    totalRosters: league.total_rosters,
    scoringFormat: format,
    rostersSynced: rows.length,
    playersMapped: totalMapped,
    playersUnmapped: totalUnmapped,
    picksSynced: pickRows.length,
  };
}
