import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { CURRENT_SEASON } from "../src/lib/dpv/constants";

// Rookie Historical Situation Matching.
//
// Veteran HSM keys off "last qualifying season" — rookies have no such thing,
// so the feature vector is pre-rookie-year (draft capital, age at draft, RAS,
// team context, intra-class depth) and the "future" columns are Y1/Y2/Y3
// half-PPR PPG from their actual NFL career.
//
// A 2026-class rookie with pick=12, age=22.1, RAS=8.4 at an above-average OL
// ends up alongside historical rookies with similar pre-draft profiles and
// lands at a similarity-weighted Y1/Y2/Y3 projection. That projection gets
// blended into the rookie prior DPV in compute-dpv.ts.

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const MIN_GAMES = 7;
const TOP_N_COMPS = 8;
const SIM_BANDWIDTH = 2.0;
const YEAR_WEIGHTS = [0.5, 0.3, 0.2] as const; // t+1, t+2, t+3
// Oldest draft class included in the historical pool. Nflverse combine data
// is denser from ~2010 on, and the pre-2005 landscape (workhorse RBs, no
// modern rookie-deal contract economics) doesn't generalize well.
const MIN_POOL_DRAFT_YEAR = 2010;

type Position = "QB" | "RB" | "WR" | "TE";

interface PlayerRow {
  player_id: string;
  name: string;
  position: string;
  birthdate: string | null;
  current_team: string | null;
  draft_round: number | null;
  draft_year: number | null;
}

interface SeasonRow {
  player_id: string;
  season: number;
  team: string | null;
  games_played: number;
  weekly_fantasy_points_half: number[] | null;
}

interface TeamSeasonRow {
  team: string;
  season: number;
  oline_composite_rank: number | null;
  qb_tier: number | null;
}

interface CombineRow {
  player_id: string;
  athleticism_score: number | null;
}

async function fetchAll<T>(table: string, cols: string): Promise<T[]> {
  const PAGE = 1000;
  const all: T[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await sb
      .from(table)
      .select(cols)
      .range(start, start + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as unknown as T[]));
    if (data.length < PAGE) break;
  }
  return all;
}

function ppgFromWeekly(points: number[] | null): number | null {
  if (!points || points.length === 0) return null;
  const total = points.reduce((a, b) => a + b, 0);
  return total / points.length;
}

function ageAtDate(birthdate: string | null, isoDate: string): number | null {
  if (!birthdate) return null;
  const a = new Date(isoDate);
  const b = new Date(birthdate);
  return (a.getTime() - b.getTime()) / (365.25 * 24 * 3600 * 1000);
}

async function fetchDraftPickOverrides(): Promise<Map<string, number>> {
  const CSV_URL =
    "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv";
  const result = new Map<string, number>();
  try {
    const res = await fetch(CSV_URL);
    if (!res.ok) return result;
    const text = await res.text();
    const lines = text.split(/\r?\n/).filter(Boolean);
    const header = lines[0]
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
    const iPick = header.indexOf("pick");
    const iGsis = header.indexOf("gsis_id");
    if (iPick < 0 || iGsis < 0) return result;
    for (const line of lines.slice(1)) {
      const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      const gsis = cols[iGsis];
      const pick = Number(cols[iPick]);
      if (!gsis || gsis === "NA" || !Number.isFinite(pick)) continue;
      result.set(gsis, pick);
    }
  } catch (e) {
    console.warn("draft_picks.csv fetch failed:", e);
  }
  return result;
}

// Feature vector (5 dims, all roughly 0-1):
//   pickNorm     — (260 - pick) / 260  (higher = earlier pick)
//   ageNorm      — (26 - ageAtDraft) / 6
//   rasNorm      — athleticism_score / 10  (mean-imputed by position if null)
//   contextNorm  — OL quality (RB/QB) or QB tier quality (WR/TE), higher = better
//   depthNorm    — intra-class depth index / 3
function buildVector(
  position: Position,
  pick: number,
  ageAtDraft: number,
  rasScore: number | null,
  rasPosMean: number,
  ctx: TeamSeasonRow | undefined,
  intraDepthIdx: number,
): number[] {
  const pickNorm = Math.max(0, Math.min(1, (260 - pick) / 260));
  const ageNorm = Math.max(0, Math.min(1, (26 - ageAtDraft) / 6));
  const rasNorm = (rasScore ?? rasPosMean) / 10;
  let contextNorm = 0.5;
  if (position === "RB" || position === "QB") {
    if (ctx?.oline_composite_rank !== undefined && ctx?.oline_composite_rank !== null) {
      contextNorm = (33 - ctx.oline_composite_rank) / 32;
    }
  } else {
    if (ctx?.qb_tier !== undefined && ctx?.qb_tier !== null) {
      contextNorm = (6 - ctx.qb_tier) / 5;
    }
  }
  const depthNorm = Math.max(0, Math.min(1, intraDepthIdx / 3));
  return [pickNorm, ageNorm, rasNorm, contextNorm, depthNorm];
}

function scaledDistance(a: number[], b: number[], invStds: number[]): number {
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
  const vars_ = new Array<number>(dim).fill(0);
  for (const v of vectors)
    for (let i = 0; i < dim; i++) {
      const d = v[i] - means[i];
      vars_[i] += d * d;
    }
  const invStds = new Array<number>(dim).fill(1);
  for (let i = 0; i < dim; i++) {
    const std = Math.sqrt(vars_[i] / vectors.length);
    invStds[i] = std > 1e-6 ? 1 / std : 1;
  }
  return invStds;
}

interface Anchor {
  playerId: string;
  name: string;
  position: Position;
  draftYear: number;
  pick: number;
  ageAtDraft: number;
  rasScore: number | null;
  vec: number[];
  nextPpg: [number | null, number | null, number | null];
}

interface Comp {
  playerId: string;
  name: string;
  draftYear: number;
  pick: number;
  ageAtDraft: number;
  rasScore: number | null;
  nextPPG1: number | null;
  nextPPG2: number | null;
  nextPPG3: number | null;
  similarity: number;
}

async function main() {
  console.log("Loading tables...");
  const [players, seasons, teams, combine] = await Promise.all([
    fetchAll<PlayerRow>(
      "players",
      "player_id,name,position,birthdate,current_team,draft_round,draft_year",
    ),
    fetchAll<SeasonRow>(
      "player_seasons",
      "player_id,season,team,games_played,weekly_fantasy_points_half",
    ),
    fetchAll<TeamSeasonRow>(
      "team_seasons",
      "team,season,oline_composite_rank,qb_tier",
    ),
    fetchAll<CombineRow>("combine_stats", "player_id,athleticism_score"),
  ]);
  console.log(
    `  players=${players.length} seasons=${seasons.length} teams=${teams.length} combine=${combine.length}`,
  );

  const playerById = new Map(players.map((p) => [p.player_id, p]));
  const teamIdx = new Map<string, TeamSeasonRow>();
  for (const t of teams) teamIdx.set(`${t.team}|${t.season}`, t);
  const rasByPlayer = new Map<string, number | null>();
  for (const c of combine) rasByPlayer.set(c.player_id, c.athleticism_score);

  // Pick overrides from nflverse draft_picks.csv. Round midpoint fallback if
  // a player isn't in the CSV (undrafted, or CSV lag for current class).
  console.log("Loading draft_picks.csv pick overrides...");
  const pickByGsis = await fetchDraftPickOverrides();
  console.log(`  ${pickByGsis.size} player→pick entries`);

  function pickFor(p: PlayerRow): number {
    const real = pickByGsis.get(p.player_id);
    if (real !== undefined) return real;
    if (p.draft_round !== null) return (p.draft_round - 1) * 32 + 16;
    return 260; // undrafted
  }

  // Per-position RAS mean for imputing nulls. Most QBs don't run combine
  // drills, so nulls are common; imputing to position mean keeps them from
  // looking like 0.0 RAS outliers.
  const rasPosMean: Record<Position, number> = {
    QB: 5,
    RB: 5,
    WR: 5,
    TE: 5,
  };
  {
    const sums = { QB: 0, RB: 0, WR: 0, TE: 0 };
    const cts = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const c of combine) {
      const p = playerById.get(c.player_id);
      if (!p || !["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      if (c.athleticism_score === null) continue;
      const pos = p.position as Position;
      sums[pos] += c.athleticism_score;
      cts[pos] += 1;
    }
    for (const pos of ["QB", "RB", "WR", "TE"] as Position[]) {
      if (cts[pos] > 0) rasPosMean[pos] = sums[pos] / cts[pos];
    }
    console.log(
      `  RAS position means: QB=${rasPosMean.QB.toFixed(2)} RB=${rasPosMean.RB.toFixed(2)} WR=${rasPosMean.WR.toFixed(2)} TE=${rasPosMean.TE.toFixed(2)}`,
    );
  }

  // Per-player qualifying-PPG-by-season, used to resolve Y1/Y2/Y3 targets.
  const ppgByPlayerSeason = new Map<string, Map<number, number>>();
  for (const s of seasons) {
    if (s.games_played < MIN_GAMES) continue;
    const ppg = ppgFromWeekly(s.weekly_fantasy_points_half);
    if (ppg === null) continue;
    let m = ppgByPlayerSeason.get(s.player_id);
    if (!m) {
      m = new Map();
      ppgByPlayerSeason.set(s.player_id, m);
    }
    m.set(s.season, ppg);
  }

  function hasAnyQualifyingSeason(pid: string): boolean {
    return (ppgByPlayerSeason.get(pid)?.size ?? 0) > 0;
  }

  // Intra-class depth: per draft_year × team × position, order rookies by
  // pick and assign index = number of earlier-drafted same-pos teammates.
  console.log("Computing intra-class depth indices...");
  const depthByPlayer = new Map<string, number>();
  {
    const groups = new Map<string, { pid: string; pick: number }[]>();
    for (const p of players) {
      if (p.draft_year === null) continue;
      if (!p.current_team) continue;
      if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
      const key = `${p.draft_year}|${p.current_team}|${p.position}`;
      const arr = groups.get(key) ?? [];
      arr.push({ pid: p.player_id, pick: pickFor(p) });
      groups.set(key, arr);
    }
    for (const [, arr] of groups) {
      arr.sort((a, b) => a.pick - b.pick);
      arr.forEach((e, i) => depthByPlayer.set(e.pid, i));
    }
  }

  // Build anchors for every rookie whose Y1 is observable (draft_year <=
  // CURRENT_SEASON - 1). Missing next-year PPG becomes null — we renormalize
  // weights dynamically per horizon, just like the veteran HSM.
  console.log("Building rookie anchors...");
  const anchors: Anchor[] = [];
  for (const p of players) {
    if (p.draft_year === null) continue;
    if (p.draft_year < MIN_POOL_DRAFT_YEAR) continue;
    if (p.draft_year > CURRENT_SEASON - 1) continue;
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
    if (!p.birthdate) continue;
    const pos = p.position as Position;
    const pick = pickFor(p);
    const ageAtDraft = ageAtDate(p.birthdate, `${p.draft_year}-04-25`);
    if (ageAtDraft === null) continue;

    // Anchor team = team they played on in Y1. If no Y1 team (undrafted
    // never-played), skip — we have nothing to anchor the context to.
    const y1Team = seasons.find(
      (s) => s.player_id === p.player_id && s.season === p.draft_year,
    )?.team;
    const ctxTeam = y1Team ?? p.current_team;
    const ctx = ctxTeam
      ? teamIdx.get(`${ctxTeam}|${p.draft_year}`) ?? undefined
      : undefined;

    const ras = rasByPlayer.get(p.player_id) ?? null;
    const depthIdx = depthByPlayer.get(p.player_id) ?? 0;
    const vec = buildVector(pos, pick, ageAtDraft, ras, rasPosMean[pos], ctx, depthIdx);

    const seasonPpg = ppgByPlayerSeason.get(p.player_id);
    const y1 = seasonPpg?.get(p.draft_year) ?? null;
    const y2 = seasonPpg?.get(p.draft_year + 1) ?? null;
    const y3 = seasonPpg?.get(p.draft_year + 2) ?? null;

    anchors.push({
      playerId: p.player_id,
      name: p.name,
      position: pos,
      draftYear: p.draft_year,
      pick,
      ageAtDraft,
      rasScore: ras,
      vec,
      nextPpg: [y1, y2, y3],
    });
  }
  console.log(`  built ${anchors.length} rookie anchors`);

  // Pool = anchors with at least Y1 observed. Per-position invStd for the
  // scaled Euclidean distance.
  const poolByPos = new Map<Position, Anchor[]>();
  for (const a of anchors) {
    if (a.nextPpg[0] === null) continue; // no Y1 qualifying season — not useful
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

  // Active rookies: no qualifying NFL season yet AND draft_year in the
  // recent-draftee window the rookie-prior path cares about.
  const INCOMING_CLASS_YEAR = CURRENT_SEASON + 1;
  const active: Array<{ p: PlayerRow; pos: Position; vec: number[]; ageAtDraft: number; pick: number; ras: number | null }> = [];
  for (const p of players) {
    if (p.draft_year === null) continue;
    if (p.draft_year < CURRENT_SEASON - 2 || p.draft_year > INCOMING_CLASS_YEAR) continue;
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
    if (hasAnyQualifyingSeason(p.player_id)) continue;
    if (!p.birthdate) continue;
    const pos = p.position as Position;
    const pick = pickFor(p);
    const ageAtDraft = ageAtDate(p.birthdate, `${p.draft_year}-04-25`);
    if (ageAtDraft === null) continue;
    // Use current_team's CURRENT_SEASON context for rookies who haven't played
    // yet (incoming class) and the most-recent season's context for lapsed
    // rookies still on their draft team.
    const ctxTeam = p.current_team;
    const ctx = ctxTeam
      ? teamIdx.get(`${ctxTeam}|${CURRENT_SEASON}`) ??
        teamIdx.get(`${ctxTeam}|${p.draft_year}`) ??
        undefined
      : undefined;
    const ras = rasByPlayer.get(p.player_id) ?? null;
    const depthIdx = depthByPlayer.get(p.player_id) ?? 0;
    const vec = buildVector(pos, pick, ageAtDraft, ras, rasPosMean[pos], ctx, depthIdx);
    active.push({ p, pos, vec, ageAtDraft, pick, ras });
  }
  console.log(`  ${active.length} active rookies to project`);

  console.log("Finding top comps per active rookie...");
  const rows: Array<{
    player_id: string;
    comps: Comp[];
    summary: {
      n: number;
      projectedPPG: number | null;
      proj1: number | null;
      proj2: number | null;
      proj3: number | null;
      n1: number;
      n2: number;
      n3: number;
    };
  }> = [];

  for (const { p, pos, vec } of active) {
    const pool = poolByPos.get(pos) ?? [];
    const invStds = invStdsByPos.get(pos) ?? [];
    const candidates = pool
      .filter((h) => h.playerId !== p.player_id)
      .map((h) => ({ h, dist: scaledDistance(vec, h.vec, invStds) }))
      .sort((x, y) => x.dist - y.dist);
    const topK = candidates.slice(0, TOP_N_COMPS);

    const comps: Comp[] = topK.map(({ h, dist }) => {
      const sim = Math.exp(-dist / SIM_BANDWIDTH);
      return {
        playerId: h.playerId,
        name: h.name,
        draftYear: h.draftYear,
        pick: h.pick,
        ageAtDraft: Math.round(h.ageAtDraft * 10) / 10,
        rasScore: h.rasScore !== null ? Math.round(h.rasScore * 10) / 10 : null,
        nextPPG1: h.nextPpg[0] !== null ? Math.round(h.nextPpg[0] * 10) / 10 : null,
        nextPPG2: h.nextPpg[1] !== null ? Math.round(h.nextPpg[1] * 10) / 10 : null,
        nextPPG3: h.nextPpg[2] !== null ? Math.round(h.nextPpg[2] * 10) / 10 : null,
        similarity: Math.round(sim * 1000) / 1000,
      };
    });

    function weightedMean(year: 0 | 1 | 2): { value: number | null; n: number } {
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

    // Renormalize year weights over observable horizons. If Y3 is null for
    // every comp (incoming class too young), the 0.2 weight gets redistributed
    // to Y1/Y2 rather than dragging the blend toward zero.
    const horizons = [y1, y2, y3];
    let projNum = 0;
    let projDen = 0;
    for (let i = 0; i < 3; i++) {
      if (horizons[i].value === null) continue;
      projNum += YEAR_WEIGHTS[i] * horizons[i].value!;
      projDen += YEAR_WEIGHTS[i];
    }
    const projectedPPG = projDen > 0 ? projNum / projDen : null;

    rows.push({
      player_id: p.player_id,
      comps,
      summary: {
        n: topK.length,
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

  console.log("Writing rookie_hsm_comps...");
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { error } = await sb
      .from("rookie_hsm_comps")
      .upsert(chunk, { onConflict: "player_id" });
    if (error) {
      console.error("Upsert error:", error);
      process.exit(1);
    }
  }
  console.log(`  wrote ${rows.length} rookie_hsm_comps`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
