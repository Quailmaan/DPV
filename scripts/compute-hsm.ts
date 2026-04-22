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

const CURRENT_SEASON = 2025;
const MIN_GAMES = 7;
const TOP_N_COMPS = 8;
const AGE_WINDOW = 2.0;

type Position = "QB" | "RB" | "WR" | "TE";

interface PlayerRow {
  player_id: string;
  name: string;
  position: string;
  birthdate: string | null;
  current_team: string | null;
}

interface SeasonRow {
  player_id: string;
  season: number;
  team: string | null;
  games_played: number;
  passing_yards: number | null;
  passing_tds: number | null;
  rushing_yards: number | null;
  rushing_tds: number | null;
  receptions: number | null;
  receiving_yards: number | null;
  receiving_tds: number | null;
  snap_share_pct: number | null;
  target_share_pct: number | null;
  opportunity_share_pct: number | null;
  weekly_fantasy_points_half: number[] | null;
}

interface TeamSeasonRow {
  team: string;
  season: number;
  oline_composite_rank: number | null;
  qb_tier: number | null;
}

async function fetchAll<T>(table: string): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select("*")
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return all;
}

function ppgFromWeekly(points: number[] | null): number | null {
  if (!points || points.length === 0) return null;
  const total = points.reduce((a, b) => a + b, 0);
  return total / points.length;
}

function ageAtSeason(birthdate: string | null, season: number): number | null {
  if (!birthdate) return null;
  const seasonStart = new Date(`${season}-09-01`);
  const bd = new Date(birthdate);
  return (seasonStart.getTime() - bd.getTime()) / (365.25 * 24 * 3600 * 1000);
}

interface Anchor {
  playerId: string;
  name: string;
  position: Position;
  season: number;
  age: number;
  ppg: number;
  vec: number[];
  nextPpg: number | null;
}

function buildVector(
  position: Position,
  s: SeasonRow,
  ppg: number,
  age: number,
  ctx: TeamSeasonRow | undefined,
): number[] {
  const snap = (s.snap_share_pct ?? 0) / 100;
  const tgt = (s.target_share_pct ?? 0) / 100;
  const opp = (s.opportunity_share_pct ?? 0) / 100;
  const ol = ctx?.oline_composite_rank
    ? (33 - ctx.oline_composite_rank) / 32
    : 0.5;
  const qb = ctx?.qb_tier ? (6 - ctx.qb_tier) / 5 : 0.5;

  // Normalized feature ranges picked to keep each ~[0,1].
  const ppgNorm = Math.min(ppg / 25, 1.2);
  const ageNorm = Math.max(0, Math.min(1, (age - 20) / 15));

  // Per-position feature emphasis
  if (position === "QB") {
    const passYd = ((s.passing_yards ?? 0) / Math.max(1, s.games_played)) / 300;
    const rushYd = ((s.rushing_yards ?? 0) / Math.max(1, s.games_played)) / 40;
    return [ppgNorm, ageNorm, passYd, rushYd, ol];
  }
  if (position === "RB") {
    return [ppgNorm, ageNorm, snap, opp || tgt, ol];
  }
  // WR / TE
  return [ppgNorm, ageNorm, snap, tgt, qb];
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface Comp {
  playerId: string;
  name: string;
  anchorSeason: number;
  anchorAge: number;
  anchorPPG: number;
  nextPPG: number | null;
  similarity: number;
}

async function main() {
  console.log("Loading tables...");
  const [players, seasons, teams] = await Promise.all([
    fetchAll<PlayerRow>("players"),
    fetchAll<SeasonRow>("player_seasons"),
    fetchAll<TeamSeasonRow>("team_seasons"),
  ]);
  console.log(
    `  players=${players.length} seasons=${seasons.length} teams=${teams.length}`,
  );

  const playerById = new Map(players.map((p) => [p.player_id, p]));
  const teamIdx = new Map<string, TeamSeasonRow>();
  for (const t of teams) teamIdx.set(`${t.team}|${t.season}`, t);

  const byPlayer = new Map<string, SeasonRow[]>();
  for (const s of seasons) {
    const arr = byPlayer.get(s.player_id) ?? [];
    arr.push(s);
    byPlayer.set(s.player_id, arr);
  }

  console.log("Building anchor vectors...");
  const anchors: Anchor[] = [];
  for (const [pid, list] of byPlayer) {
    const player = playerById.get(pid);
    if (!player) continue;
    if (!["QB", "RB", "WR", "TE"].includes(player.position)) continue;
    list.sort((a, b) => a.season - b.season);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.games_played < MIN_GAMES) continue;
      const ppg = ppgFromWeekly(s.weekly_fantasy_points_half);
      if (ppg === null) continue;
      const age = ageAtSeason(player.birthdate, s.season);
      if (age === null) continue;
      const ctx = s.team
        ? teamIdx.get(`${s.team}|${s.season}`)
        : undefined;
      const vec = buildVector(
        player.position as Position,
        s,
        ppg,
        age,
        ctx,
      );

      // Next-season PPG (if qualifying)
      let nextPpg: number | null = null;
      const nextSeason = list[i + 1];
      if (
        nextSeason &&
        nextSeason.season === s.season + 1 &&
        nextSeason.games_played >= MIN_GAMES
      ) {
        nextPpg = ppgFromWeekly(nextSeason.weekly_fantasy_points_half);
      }

      anchors.push({
        playerId: pid,
        name: player.name,
        position: player.position as Position,
        season: s.season,
        age,
        ppg,
        vec,
        nextPpg,
      });
    }
  }
  console.log(`  built ${anchors.length} anchors`);

  // Active anchors = most recent anchor for each active player (season >= CURRENT_SEASON-1)
  const activeByPlayer = new Map<string, Anchor>();
  for (const a of anchors) {
    if (a.season < CURRENT_SEASON - 1) continue;
    const prev = activeByPlayer.get(a.playerId);
    if (!prev || a.season > prev.season) activeByPlayer.set(a.playerId, a);
  }
  console.log(`  ${activeByPlayer.size} active players to comp`);

  // Historical pool = anchors before CURRENT_SEASON - 1 (have at least one
  // future season observable) — must have nextPpg to contribute to trajectory.
  const poolByPos = new Map<Position, Anchor[]>();
  for (const a of anchors) {
    if (a.season >= CURRENT_SEASON - 1) continue;
    const arr = poolByPos.get(a.position) ?? [];
    arr.push(a);
    poolByPos.set(a.position, arr);
  }
  for (const [pos, arr] of poolByPos) {
    console.log(`    pool[${pos}]: ${arr.length}`);
  }

  console.log("Finding top comps per active player...");
  const rows: Array<{
    player_id: string;
    comps: Comp[];
    summary: {
      n: number;
      meanNextPPG: number | null;
      medianNextPPG: number | null;
      breakoutRate: number | null;
      bustRate: number | null;
    };
  }> = [];

  for (const [pid, a] of activeByPlayer) {
    const pool = poolByPos.get(a.position) ?? [];
    const candidates = pool
      .filter(
        (h) =>
          h.playerId !== pid &&
          Math.abs(h.age - a.age) <= AGE_WINDOW,
      )
      .map((h) => ({ h, sim: cosine(a.vec, h.vec) }))
      .sort((x, y) => y.sim - x.sim);

    const comps: Comp[] = candidates.slice(0, TOP_N_COMPS).map(({ h, sim }) => ({
      playerId: h.playerId,
      name: h.name,
      anchorSeason: h.season,
      anchorAge: Math.round(h.age * 10) / 10,
      anchorPPG: Math.round(h.ppg * 10) / 10,
      nextPPG: h.nextPpg !== null ? Math.round(h.nextPpg * 10) / 10 : null,
      similarity: Math.round(sim * 1000) / 1000,
    }));

    const withNext = comps.filter((c) => c.nextPPG !== null);
    const nextVals = withNext.map((c) => c.nextPPG!);
    const mean =
      nextVals.length > 0
        ? nextVals.reduce((a, b) => a + b, 0) / nextVals.length
        : null;
    const sorted = [...nextVals].sort((a, b) => a - b);
    const median =
      sorted.length > 0
        ? sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)]
        : null;
    const breakoutThresh = a.position === "QB" ? 20 : 15;
    const bustThresh = a.position === "QB" ? 14 : 8;
    const breakoutRate =
      nextVals.length > 0
        ? nextVals.filter((v) => v >= breakoutThresh).length / nextVals.length
        : null;
    const bustRate =
      nextVals.length > 0
        ? nextVals.filter((v) => v <= bustThresh).length / nextVals.length
        : null;

    rows.push({
      player_id: pid,
      comps,
      summary: {
        n: withNext.length,
        meanNextPPG: mean !== null ? Math.round(mean * 10) / 10 : null,
        medianNextPPG: median !== null ? Math.round(median * 10) / 10 : null,
        breakoutRate:
          breakoutRate !== null ? Math.round(breakoutRate * 100) / 100 : null,
        bustRate: bustRate !== null ? Math.round(bustRate * 100) / 100 : null,
      },
    });
  }

  console.log("Writing hsm_comps...");
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("hsm_comps")
      .upsert(chunk, { onConflict: "player_id" });
    if (error) {
      console.error("Upsert error:", error);
      process.exit(1);
    }
  }
  console.log(`  wrote ${rows.length} hsm_comps`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
