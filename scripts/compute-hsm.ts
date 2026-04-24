import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

// Historical Situation Matching.
//
// For each active player, we find the historical (player, season) anchors
// most like their most recent qualifying season and report what happened
// next. Improvements over the v1 implementation:
//
//   * Per-position feature vectors are richer (7 dims instead of 5) and
//     include a trajectory feature (PPG delta vs prior season). Two WRs
//     with identical snapshots but one trending up and one trending down
//     now look different to the comp engine.
//   * Distance is scaled Euclidean using per-feature standard deviation
//     within the pool. Cosine was scale-invariant — it called a 0.8 PPG
//     guy and a 0.4 PPG guy "identical" if their feature ratios matched.
//     Euclidean on standardized features actually penalizes those gaps.
//   * Similarity = exp(-d/2). Closer comps dominate the weighted average,
//     distant comps decay smoothly instead of all counting equally.
//   * Projections span three seasons: t+1, t+2, t+3. Dynasty value lives
//     over that horizon, not just next year. The blended projection is a
//     similarity-weighted 0.5/0.3/0.2 mix that degrades gracefully when
//     the tail years are unobservable for some comps.

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
const SIM_BANDWIDTH = 2.0; // higher = less discrimination between close and far comps
const YEAR_WEIGHTS = [0.5, 0.3, 0.2] as const; // t+1, t+2, t+3

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
  // PPG in each of the next three seasons (if qualifying). Null means the
  // player didn't play a qualifying season that year — retired, injured,
  // or pre-production. We keep the shape so downstream code can reason
  // about what was observable.
  nextPpg: [number | null, number | null, number | null];
}

// Returns [vec, seasonPpg]. Pass prevPpg so we can build the trajectory
// feature (PPG delta vs prior qualifying season).
function buildVector(
  position: Position,
  s: SeasonRow,
  ppg: number,
  age: number,
  ctx: TeamSeasonRow | undefined,
  prevPpg: number | null,
): number[] {
  const snap = (s.snap_share_pct ?? 0) / 100;
  const tgt = (s.target_share_pct ?? 0) / 100;
  const opp = (s.opportunity_share_pct ?? 0) / 100;
  const ol = ctx?.oline_composite_rank
    ? (33 - ctx.oline_composite_rank) / 32
    : 0.5;
  const qb = ctx?.qb_tier ? (6 - ctx.qb_tier) / 5 : 0.5;

  const ppgNorm = Math.min(ppg / 25, 1.2);
  const ageNorm = Math.max(0, Math.min(1, (age - 20) / 15));
  const gamesNorm = Math.min((s.games_played ?? 0) / 17, 1);

  // PPG trajectory: how much did production change year over year? Rookies
  // and others without a prior qualifying season get 0 (flat). Divide by
  // max(prev, 5) so tiny prev-season PPG doesn't create absurd deltas.
  const delta =
    prevPpg !== null
      ? Math.max(-1, Math.min(1, (ppg - prevPpg) / Math.max(prevPpg, 5)))
      : 0;

  if (position === "QB") {
    const passYd = ((s.passing_yards ?? 0) / Math.max(1, s.games_played)) / 300;
    const rushYds = s.rushing_yards ?? 0;
    const passYds = s.passing_yards ?? 0;
    const rushShare =
      rushYds + passYds > 0 ? rushYds / (rushYds + passYds) : 0;
    return [ppgNorm, ageNorm, passYd, rushShare, ol, gamesNorm, delta];
  }
  if (position === "RB") {
    const rec = s.receptions ?? 0;
    const recPerGm = Math.min(rec / Math.max(1, s.games_played) / 5, 1.2);
    return [ppgNorm, ageNorm, snap, opp || tgt, recPerGm, ol, delta];
  }
  // WR / TE
  const rec = s.receptions ?? 0;
  const recYds = s.receiving_yards ?? 0;
  const yprNorm = rec > 0 ? Math.min(recYds / rec / 20, 1.2) : 0;
  return [ppgNorm, ageNorm, snap, tgt, yprNorm, qb, delta];
}

// Scaled Euclidean distance using per-feature standard deviation. Features
// with tight population spreads (snap share clusters in 70-90 for starters)
// get amplified — a small diff becomes meaningful. Wide-spread features
// (PPG varies 0-30) get damped.
function scaledDistance(
  a: number[],
  b: number[],
  invStds: number[],
): number {
  let d2 = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] - b[i]) * invStds[i];
    d2 += diff * diff;
  }
  return Math.sqrt(d2);
}

function computeInvStds(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const means = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) means[i] += v[i];
  for (let i = 0; i < dim; i++) means[i] /= vectors.length;
  const vars = new Array<number>(dim).fill(0);
  for (const v of vectors)
    for (let i = 0; i < dim; i++) {
      const d = v[i] - means[i];
      vars[i] += d * d;
    }
  const invStds = new Array<number>(dim).fill(1);
  for (let i = 0; i < dim; i++) {
    const std = Math.sqrt(vars[i] / vectors.length);
    invStds[i] = std > 1e-6 ? 1 / std : 1; // zero-variance feature → no scaling
  }
  return invStds;
}

interface Comp {
  playerId: string;
  name: string;
  anchorSeason: number;
  anchorAge: number;
  anchorPPG: number;
  nextPPG: number | null; // kept for back-compat with existing UI
  nextPPG1: number | null;
  nextPPG2: number | null;
  nextPPG3: number | null;
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

    // Pre-compute each season's PPG once so we can look up trajectory and
    // forward-looking projections without scanning the list repeatedly.
    const seasonPpg = new Map<number, number>();
    for (const s of list) {
      if (s.games_played < MIN_GAMES) continue;
      const ppg = ppgFromWeekly(s.weekly_fantasy_points_half);
      if (ppg !== null) seasonPpg.set(s.season, ppg);
    }

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (s.games_played < MIN_GAMES) continue;
      const ppg = seasonPpg.get(s.season);
      if (ppg === undefined) continue;
      const age = ageAtSeason(player.birthdate, s.season);
      if (age === null) continue;
      const ctx = s.team
        ? teamIdx.get(`${s.team}|${s.season}`)
        : undefined;

      // Trajectory: most recent prior qualifying season's PPG. Walk back
      // up to 2 seasons so a one-year injury absence doesn't erase the
      // trend signal.
      let prevPpg: number | null = null;
      for (let back = 1; back <= 2; back++) {
        const hit = seasonPpg.get(s.season - back);
        if (hit !== undefined) {
          prevPpg = hit;
          break;
        }
      }

      const vec = buildVector(
        player.position as Position,
        s,
        ppg,
        age,
        ctx,
        prevPpg,
      );

      const nextPpg: [number | null, number | null, number | null] = [
        seasonPpg.get(s.season + 1) ?? null,
        seasonPpg.get(s.season + 2) ?? null,
        seasonPpg.get(s.season + 3) ?? null,
      ];

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

  // Active anchors = most recent qualifying season for players whose last
  // anchor is in CURRENT_SEASON-1 or later. These are the rows we project.
  const activeByPlayer = new Map<string, Anchor>();
  for (const a of anchors) {
    if (a.season < CURRENT_SEASON - 1) continue;
    const prev = activeByPlayer.get(a.playerId);
    if (!prev || a.season > prev.season) activeByPlayer.set(a.playerId, a);
  }
  console.log(`  ${activeByPlayer.size} active players to comp`);

  // Historical pool = anchors before CURRENT_SEASON - 1. These have at
  // least one observable future season; some have all three.
  const poolByPos = new Map<Position, Anchor[]>();
  for (const a of anchors) {
    if (a.season >= CURRENT_SEASON - 1) continue;
    const arr = poolByPos.get(a.position) ?? [];
    arr.push(a);
    poolByPos.set(a.position, arr);
  }
  const invStdsByPos = new Map<Position, number[]>();
  for (const [pos, arr] of poolByPos) {
    const invStds = computeInvStds(arr.map((a) => a.vec));
    invStdsByPos.set(pos, invStds);
    console.log(
      `    pool[${pos}]: ${arr.length} anchors, feature stds ${invStds.map((x) => (1 / x).toFixed(2)).join(", ")}`,
    );
  }

  console.log("Finding top comps per active player...");
  const rows: Array<{
    player_id: string;
    comps: Comp[];
    summary: {
      // Back-compat fields read by compute-dpv.ts in its current shape.
      n: number;
      meanNextPPG: number | null;
      medianNextPPG: number | null;
      breakoutRate: number | null;
      bustRate: number | null;
      // New multi-year projection fields.
      projectedPPG: number | null; // weighted blend across years
      proj1: number | null;
      proj2: number | null;
      proj3: number | null;
      n1: number;
      n2: number;
      n3: number;
    };
  }> = [];

  for (const [pid, a] of activeByPlayer) {
    const pool = poolByPos.get(a.position) ?? [];
    const invStds = invStdsByPos.get(a.position) ?? [];
    const candidates = pool
      .filter(
        (h) => h.playerId !== pid && Math.abs(h.age - a.age) <= AGE_WINDOW,
      )
      .map((h) => ({
        h,
        dist: scaledDistance(a.vec, h.vec, invStds),
      }))
      .sort((x, y) => x.dist - y.dist);

    const topK = candidates.slice(0, TOP_N_COMPS);
    const comps: Comp[] = topK.map(({ h, dist }) => {
      const sim = Math.exp(-dist / SIM_BANDWIDTH);
      return {
        playerId: h.playerId,
        name: h.name,
        anchorSeason: h.season,
        anchorAge: Math.round(h.age * 10) / 10,
        anchorPPG: Math.round(h.ppg * 10) / 10,
        nextPPG: h.nextPpg[0] !== null ? Math.round(h.nextPpg[0] * 10) / 10 : null,
        nextPPG1: h.nextPpg[0] !== null ? Math.round(h.nextPpg[0] * 10) / 10 : null,
        nextPPG2: h.nextPpg[1] !== null ? Math.round(h.nextPpg[1] * 10) / 10 : null,
        nextPPG3: h.nextPpg[2] !== null ? Math.round(h.nextPpg[2] * 10) / 10 : null,
        similarity: Math.round(sim * 1000) / 1000,
      };
    });

    // Similarity-weighted projections per horizon year. Drop comps whose
    // next-year PPG is unobservable for that specific year — partial info
    // is fine, we just shrink the effective sample.
    function weightedMean(year: 0 | 1 | 2): {
      value: number | null;
      n: number;
    } {
      let num = 0;
      let den = 0;
      let n = 0;
      for (const c of topK) {
        const v = c.h.nextPpg[year];
        if (v === null) continue;
        const sim = Math.exp(-c.dist / SIM_BANDWIDTH);
        num += sim * v;
        den += sim;
        n++;
      }
      return { value: den > 0 ? num / den : null, n };
    }
    const y1 = weightedMean(0);
    const y2 = weightedMean(1);
    const y3 = weightedMean(2);

    // Renormalize year weights across the horizons we actually have data
    // for. If t+2 is null, the 0.3 weight gets redistributed proportionally
    // to t+1 and t+3. Avoids crashing projections just because one comp's
    // future season isn't in the books yet.
    const horizons = [y1, y2, y3];
    let projNum = 0;
    let projDen = 0;
    for (let i = 0; i < 3; i++) {
      if (horizons[i].value === null) continue;
      projNum += YEAR_WEIGHTS[i] * horizons[i].value!;
      projDen += YEAR_WEIGHTS[i];
    }
    const projectedPPG = projDen > 0 ? projNum / projDen : null;

    // Legacy mean/median (unweighted, t+1 only) kept so anyone reading the
    // old summary shape still gets sensible numbers.
    const next1Vals = topK
      .map((c) => c.h.nextPpg[0])
      .filter((v): v is number => v !== null);
    const mean =
      next1Vals.length > 0
        ? next1Vals.reduce((a, b) => a + b, 0) / next1Vals.length
        : null;
    const sorted = [...next1Vals].sort((a, b) => a - b);
    const median =
      sorted.length > 0
        ? sorted.length % 2 === 0
          ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
          : sorted[Math.floor(sorted.length / 2)]
        : null;
    const breakoutThresh = a.position === "QB" ? 20 : 15;
    const bustThresh = a.position === "QB" ? 14 : 8;
    const breakoutRate =
      next1Vals.length > 0
        ? next1Vals.filter((v) => v >= breakoutThresh).length / next1Vals.length
        : null;
    const bustRate =
      next1Vals.length > 0
        ? next1Vals.filter((v) => v <= bustThresh).length / next1Vals.length
        : null;

    rows.push({
      player_id: pid,
      comps,
      summary: {
        n: next1Vals.length,
        meanNextPPG: mean !== null ? Math.round(mean * 10) / 10 : null,
        medianNextPPG: median !== null ? Math.round(median * 10) / 10 : null,
        breakoutRate:
          breakoutRate !== null ? Math.round(breakoutRate * 100) / 100 : null,
        bustRate: bustRate !== null ? Math.round(bustRate * 100) / 100 : null,
        projectedPPG:
          projectedPPG !== null ? Math.round(projectedPPG * 10) / 10 : null,
        proj1: y1.value !== null ? Math.round(y1.value * 10) / 10 : null,
        proj2: y2.value !== null ? Math.round(y2.value * 10) / 10 : null,
        proj3: y3.value !== null ? Math.round(y3.value * 10) / 10 : null,
        n1: y1.n,
        n2: y2.n,
        n3: y3.n,
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
