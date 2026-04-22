import { createClient } from "@supabase/supabase-js";

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
};

export async function syncSleeperLeague(
  leagueId: string,
): Promise<SyncResult> {
  const id = leagueId.trim();
  if (!/^\d+$/.test(id)) {
    throw new Error("League ID must be a numeric Sleeper ID.");
  }

  const [leagueRes, usersRes, rostersRes] = await Promise.all([
    fetch(`https://api.sleeper.app/v1/league/${id}`),
    fetch(`https://api.sleeper.app/v1/league/${id}/users`),
    fetch(`https://api.sleeper.app/v1/league/${id}/rosters`),
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

  return {
    leagueId: league.league_id,
    name: league.name,
    season: league.season,
    totalRosters: league.total_rosters,
    scoringFormat: format,
    rostersSynced: rows.length,
    playersMapped: totalMapped,
    playersUnmapped: totalUnmapped,
  };
}
