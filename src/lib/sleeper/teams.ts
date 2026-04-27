import "server-only";

// Sleeper-based team lookup for players who don't yet have a row in our
// `players` table. The canonical team source is `players.current_team`,
// which is updated nightly by scripts/sync-teams.ts — but that script only
// updates EXISTING rows. Right after the NFL draft, brand-new rookies
// don't have player records yet (nflverse draft_picks.csv typically lags
// 1-3 days), so Sleeper is the only thing that knows which team they
// landed on. This util fills that gap.
//
// Returns Map<"normalizedName|POS", teamAbbrev>. Cached in-process for 1h
// + via Next's fetch cache, so a page render is one Map lookup, not an
// HTTP call.

const SLEEPER_URL = "https://api.sleeper.app/v1/players/nfl";

type SleeperApi = Record<
  string,
  {
    player_id: string;
    full_name?: string;
    first_name?: string;
    last_name?: string;
    position?: string;
    team?: string | null;
    status?: string;
    years_exp?: number;
  }
>;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sleeperTeamKey(name: string, pos: string): string {
  return `${normalizeName(name)}|${pos.toUpperCase()}`;
}

// Sleeper uses LAR; nflverse / our DB uses LA. One-line normalization.
function normalizeTeam(t: string): string {
  return t === "LAR" ? "LA" : t;
}

let memCache: { data: Map<string, string>; ts: number } | null = null;
const TTL_MS = 60 * 60 * 1000; // 1h

export async function fetchSleeperTeams(): Promise<Map<string, string>> {
  const now = Date.now();
  if (memCache && now - memCache.ts < TTL_MS) return memCache.data;

  let json: SleeperApi;
  try {
    const res = await fetch(SLEEPER_URL, { next: { revalidate: 3600 } });
    if (!res.ok) {
      // Don't crash the page on a Sleeper outage — return whatever we have
      // (possibly stale, possibly empty) and let callers fall back to "—".
      return memCache?.data ?? new Map();
    }
    json = (await res.json()) as SleeperApi;
  } catch {
    return memCache?.data ?? new Map();
  }

  const map = new Map<string, string>();
  for (const p of Object.values(json)) {
    if (!p.team) continue;
    if (p.status !== "Active") continue;
    const name =
      p.full_name ??
      `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim();
    if (!name || !p.position) continue;
    map.set(sleeperTeamKey(name, p.position), normalizeTeam(p.team));
  }
  memCache = { data: map, ts: now };
  return map;
}
