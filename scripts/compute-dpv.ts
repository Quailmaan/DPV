import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { calculateDPV } from "../src/lib/dpv/dpv";
import { CURRENT_SEASON } from "../src/lib/dpv/constants";
import {
  computeRookiePrior,
  rookiePriorTier,
} from "../src/lib/dpv/rookie-prior";
import { rookieDisplacementModifier } from "../src/lib/dpv/situation";
import type {
  DPVInput,
  Position,
  QBTier,
  ScoringFormat,
  SeasonStats,
} from "../src/lib/dpv/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const FORMATS: ScoringFormat[] = ["STANDARD", "HALF_PPR", "FULL_PPR"];
const TODAY = new Date("2026-04-22");

function computeAge(birthdate: string | null): number | null {
  if (!birthdate) return null;
  const bd = new Date(birthdate);
  const diff = TODAY.getTime() - bd.getTime();
  return diff / (365.25 * 24 * 3600 * 1000);
}

function toSeasonStats(row: {
  season: number;
  games_played: number;
  passing_yards: number | null;
  passing_tds: number | null;
  interceptions: number | null;
  rushing_yards: number | null;
  rushing_tds: number | null;
  receptions: number | null;
  receiving_yards: number | null;
  receiving_tds: number | null;
  fumbles_lost: number | null;
  weekly_fantasy_points_half: number[] | null;
}): SeasonStats {
  return {
    season: row.season,
    gamesPlayed: row.games_played ?? 0,
    passingYards: row.passing_yards ?? 0,
    passingTDs: row.passing_tds ?? 0,
    interceptions: row.interceptions ?? 0,
    rushingYards: row.rushing_yards ?? 0,
    rushingTDs: row.rushing_tds ?? 0,
    receptions: row.receptions ?? 0,
    receivingYards: row.receiving_yards ?? 0,
    receivingTDs: row.receiving_tds ?? 0,
    fumblesLost: row.fumbles_lost ?? 0,
    weeklyFantasyPoints: row.weekly_fantasy_points_half ?? undefined,
  };
}

// The draft class that just arrived (post-draft, pre-rookie-season). With
// CURRENT_SEASON reflecting the most-recently-completed NFL season, these
// rookies have draft_year = CURRENT_SEASON + 1 and are the ones doing the
// displacing on veteran depth charts this cycle.
const INCOMING_CLASS_YEAR = CURRENT_SEASON + 1;

type CurveBucket = {
  minPick: number;
  maxPick: number;
  n: number;
  qualifierRate: number;
  meanYear1PPG: number;
  conditionalMeanPPG: number;
};

type DraftCapitalCurve = {
  metadata: { computedAt: string; seasonRange: string; totalPicks: number };
  curve: Record<string, Record<string, CurveBucket>>;
};

function loadDraftCapitalCurve(): DraftCapitalCurve {
  const path = resolve("src/lib/dpv/draft-capital-curve.json");
  return JSON.parse(readFileSync(path, "utf8")) as DraftCapitalCurve;
}

function bucketThreat(
  curve: DraftCapitalCurve,
  position: Position,
  overallPick: number | null,
  round: number | null,
): number {
  const posCurve = curve.curve[position];
  if (!posCurve) return 0;
  if (overallPick !== null) {
    for (const b of Object.values(posCurve)) {
      if (overallPick >= b.minPick && overallPick <= b.maxPick)
        return b.meanYear1PPG;
    }
  }
  // Fallback: estimate overall pick from round midpoint.
  if (round !== null) {
    const estPick = Math.round((round - 1) * 32 + 16);
    for (const b of Object.values(posCurve)) {
      if (estPick >= b.minPick && estPick <= b.maxPick) return b.meanYear1PPG;
    }
  }
  return 0;
}

async function fetchDraftPickOverrides(): Promise<Map<string, number>> {
  // nflverse draft_picks.csv for gsis_id → overall pick. Falls back to empty
  // map if the CSV isn't reachable or the incoming class isn't in it yet.
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
    const iSeason = header.indexOf("season");
    const iPick = header.indexOf("pick");
    const iGsis = header.indexOf("gsis_id");
    if (iSeason < 0 || iPick < 0 || iGsis < 0) return result;
    for (const line of lines.slice(1)) {
      const cols = line.split(",").map((c) => c.replace(/^"|"$/g, "").trim());
      const gsis = cols[iGsis];
      const pick = Number(cols[iPick]);
      if (!gsis || gsis === "NA" || !Number.isFinite(pick)) continue;
      result.set(gsis, pick);
    }
  } catch (e) {
    console.warn("draft_picks.csv fetch failed, using round-only pick estimates:", e);
  }
  return result;
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

async function main() {
  console.log("Loading players...");
  const players = await fetchAll<{
    player_id: string;
    name: string;
    position: string;
    birthdate: string | null;
    current_team: string | null;
    draft_round: number | null;
    draft_year: number | null;
  }>("players");
  console.log(`  ${players.length} players`);

  console.log("Loading player_seasons...");
  const seasons = await fetchAll<{
    player_id: string;
    season: number;
    team: string | null;
    games_played: number;
    passing_yards: number | null;
    passing_tds: number | null;
    interceptions: number | null;
    rushing_yards: number | null;
    rushing_tds: number | null;
    receptions: number | null;
    receiving_yards: number | null;
    receiving_tds: number | null;
    fumbles_lost: number | null;
    snap_share_pct: number | null;
    target_share_pct: number | null;
    opportunity_share_pct: number | null;
    weekly_fantasy_points_half: number[] | null;
  }>("player_seasons");
  console.log(`  ${seasons.length} player-seasons`);

  console.log("Loading team_seasons...");
  const teams = await fetchAll<{
    team: string;
    season: number;
    oline_composite_rank: number | null;
    qb_tier: number | null;
  }>("team_seasons");
  const teamIdx = new Map<string, (typeof teams)[number]>();
  for (const t of teams) teamIdx.set(`${t.team}|${t.season}`, t);

  console.log("Loading hsm_comps...");
  const hsmRows = await fetchAll<{
    player_id: string;
    summary: {
      n: number;
      meanNextPPG: number | null;
      medianNextPPG: number | null;
      projectedPPG?: number | null;
      proj1?: number | null;
      proj2?: number | null;
      proj3?: number | null;
      n1?: number;
      n2?: number;
      n3?: number;
    };
  }>("hsm_comps");
  const hsmByPlayer = new Map<string, (typeof hsmRows)[number]["summary"]>();
  for (const h of hsmRows) hsmByPlayer.set(h.player_id, h.summary);
  console.log(`  ${hsmRows.length} hsm summaries`);

  const byPlayer = new Map<string, typeof seasons>();
  for (const s of seasons) {
    const arr = byPlayer.get(s.player_id) ?? [];
    arr.push(s);
    byPlayer.set(s.player_id, arr);
  }

  console.log("Loading draft capital curve + nflverse pick overrides...");
  const curve = loadDraftCapitalCurve();
  const pickByGsis = await fetchDraftPickOverrides();
  console.log(`  ${pickByGsis.size} player→pick entries`);

  console.log("Loading combine_stats...");
  const combineRows = await fetchAll<{
    player_id: string;
    athleticism_score: number | null;
  }>("combine_stats");
  const athleticismByPlayer = new Map<string, number | null>();
  for (const c of combineRows) {
    athleticismByPlayer.set(c.player_id, c.athleticism_score);
  }
  console.log(`  ${combineRows.length} combine rows`);

  console.log("Loading rookie_hsm_comps...");
  const rookieHsmRows = await fetchAll<{
    player_id: string;
    summary: {
      n: number;
      projectedPPG: number | null;
    };
  }>("rookie_hsm_comps");
  const rookieHsmByPlayer = new Map<
    string,
    { projectedPPG: number | null; n: number }
  >();
  for (const r of rookieHsmRows) {
    rookieHsmByPlayer.set(r.player_id, {
      projectedPPG: r.summary?.projectedPPG ?? null,
      n: r.summary?.n ?? 0,
    });
  }
  console.log(`  ${rookieHsmRows.length} rookie_hsm summaries`);

  // Group current-class (just-drafted) rookies by team|position and order them
  // by overall pick. Each rookie gets an intraClassDepthIdx equal to the count
  // of same-team same-position peers drafted ahead of them. Also aggregate
  // total rookie Year-1-PPG threat per team|position for veteran displacement.
  type IncomingRookie = {
    player_id: string;
    position: Position;
    team: string;
    pick: number | null;
    round: number | null;
    threatPPG: number;
  };
  const incomingByTeamPos = new Map<string, IncomingRookie[]>();
  for (const p of players) {
    if (p.draft_year !== INCOMING_CLASS_YEAR) continue;
    if (!p.current_team) continue;
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) continue;
    const pos = p.position as Position;
    const pick = pickByGsis.get(p.player_id) ?? null;
    const threat = bucketThreat(curve, pos, pick, p.draft_round);
    const key = `${p.current_team}|${pos}`;
    const arr = incomingByTeamPos.get(key) ?? [];
    arr.push({
      player_id: p.player_id,
      position: pos,
      team: p.current_team,
      pick,
      round: p.draft_round,
      threatPPG: threat,
    });
    incomingByTeamPos.set(key, arr);
  }
  // Sort each group ascending by pick (earlier pick = lower depth index).
  // Round is a coarse tiebreaker when overall pick is missing.
  for (const arr of incomingByTeamPos.values()) {
    arr.sort((a, b) => {
      const pa = a.pick ?? (a.round ?? 10) * 32;
      const pb = b.pick ?? (b.round ?? 10) * 32;
      return pa - pb;
    });
  }
  const intraDepthByPlayer = new Map<string, number>();
  const teamPosThreat = new Map<string, number>();
  for (const [key, arr] of incomingByTeamPos) {
    let totalThreat = 0;
    arr.forEach((r, i) => {
      intraDepthByPlayer.set(r.player_id, i);
      totalThreat += r.threatPPG;
    });
    teamPosThreat.set(key, totalThreat);
  }
  const totalIncoming = [...incomingByTeamPos.values()].reduce(
    (n, arr) => n + arr.length,
    0,
  );
  console.log(
    `  ${totalIncoming} incoming-class rookies across ${incomingByTeamPos.size} team|position slots`,
  );

  function priorShareFor(
    position: Position,
    row: (typeof seasons)[number] | undefined,
  ): number | null {
    if (!row) return null;
    if (position === "RB") return row.opportunity_share_pct ?? null;
    if (position === "WR" || position === "TE")
      return row.target_share_pct ?? null;
    return row.snap_share_pct ?? null;
  }

  function displacementFor(
    position: Position,
    team: string | null,
    priorShare: number | null,
    selfPlayerId: string | null,
    selfThreatPPG: number,
  ): number {
    if (!team) return 1.0;
    const key = `${team}|${position}`;
    const total = teamPosThreat.get(key) ?? 0;
    // If caller is themselves a current-class rookie, subtract their own
    // threat so they don't displace themselves.
    const competing =
      selfPlayerId && intraDepthByPlayer.has(selfPlayerId)
        ? Math.max(0, total - selfThreatPPG)
        : total;
    return rookieDisplacementModifier(competing, priorShare);
  }

  type Prelim = {
    playerId: string;
    position: Position;
    input: DPVInput;
    preDPV: number;
  };

  const prelim: Record<ScoringFormat, Prelim[]> = {
    STANDARD: [],
    HALF_PPR: [],
    FULL_PPR: [],
  };

  let computed = 0;
  let priored = 0;
  let skipped = 0;

  // Pre-collect rookie prior rows so they write alongside the ranked snapshots.
  const priorSnapshots: Array<{
    player_id: string;
    scoring_format: ScoringFormat;
    dpv: number;
    tier: string;
    breakdown: unknown;
  }> = [];

  for (const p of players) {
    if (!["QB", "RB", "WR", "TE"].includes(p.position)) {
      skipped++;
      continue;
    }

    const age = computeAge(p.birthdate);
    if (age === null) {
      skipped++;
      continue;
    }

    const allSeasons = byPlayer.get(p.player_id) ?? [];
    const rawSeasons = allSeasons
      .filter((s) => s.games_played >= 7)
      .sort((a, b) => b.season - a.season);

    // Rookie prior path: no qualifying NFL season yet, but drafted recently
    // enough to be a dynasty asset. Emits a forward-looking prior so they
    // appear in rankings and are tradeable. Each post-draft season without a
    // qualifying year applies a lapse multiplier — the prior assumes a player
    // will produce on rookie-contract draft capital, and each missed year is
    // strong evidence against that assumption.
    if (rawSeasons.length === 0) {
      const isRecentDraftee =
        p.draft_year !== null && p.draft_year >= CURRENT_SEASON - 2;
      if (!isRecentDraftee) {
        skipped++;
        continue;
      }
      const situationTeam = p.current_team;
      const teamCtx = situationTeam
        ? teamIdx.get(`${situationTeam}|${CURRENT_SEASON}`) ?? null
        : null;
      const ageAtDraft =
        p.draft_year !== null && p.birthdate
          ? (new Date(`${p.draft_year}-04-25`).getTime() -
              new Date(p.birthdate).getTime()) /
            (365.25 * 24 * 3600 * 1000)
          : age;
      // Count completed NFL seasons since (and including) the rookie year.
      // draft_year 2024 + CURRENT_SEASON 2025 → 2 completed seasons (2024, 2025),
      // so 2 missed opportunities to log a qualifying year. An incoming class
      // (draft_year > CURRENT_SEASON) has 0 missed seasons.
      const missedSeasons =
        p.draft_year !== null && p.draft_year <= CURRENT_SEASON
          ? CURRENT_SEASON - p.draft_year + 1
          : 0;
      const maxGamesPlayed = allSeasons.reduce(
        (m, s) => Math.max(m, s.games_played ?? 0),
        0,
      );
      const intraClassDepthIdx =
        intraDepthByPlayer.get(p.player_id) ?? 0;
      const selfThreat = bucketThreat(
        curve,
        p.position as Position,
        pickByGsis.get(p.player_id) ?? null,
        p.draft_round,
      );
      const rookieDisplacementMult =
        missedSeasons >= 1
          ? displacementFor(
              p.position as Position,
              p.current_team,
              null,
              p.player_id,
              selfThreat,
            )
          : 1.0;
      const athleticismScore = athleticismByPlayer.get(p.player_id) ?? null;
      const rookieHsm = rookieHsmByPlayer.get(p.player_id);
      for (const fmt of FORMATS) {
        const prior = computeRookiePrior({
          position: p.position as Position,
          draftRound: p.draft_round,
          ageAtDraft,
          teamOLineRank: teamCtx?.oline_composite_rank ?? null,
          qbTier: (teamCtx?.qb_tier ?? null) as QBTier | null,
          scoringFormat: fmt,
          missedSeasons,
          maxGamesPlayed,
          intraClassDepthIdx,
          rookieDisplacementMult,
          athleticismScore,
          hsmProjectedPPG: rookieHsm?.projectedPPG ?? null,
          hsmN: rookieHsm?.n ?? 0,
        });
        priorSnapshots.push({
          player_id: p.player_id,
          scoring_format: fmt,
          dpv: prior.dpv,
          tier: rookiePriorTier(
            p.position as Position,
            p.draft_round,
            missedSeasons,
          ),
          breakdown: prior.breakdown,
        });
      }
      priored++;
      continue;
    }

    const mostRecent = rawSeasons[0];
    // Skip retired players — only rank players with a qualifying season
    // within the last 2 years.
    if (mostRecent.season < CURRENT_SEASON - 1) {
      skipped++;
      continue;
    }
    // Situation context reflects the team they'll play for NEXT — use
    // players.current_team against the most recent team_seasons row for
    // that team. Falls back to mostRecent.team if current_team isn't set.
    const situationTeam = p.current_team ?? mostRecent.team;
    const teamCtx = situationTeam
      ? teamIdx.get(`${situationTeam}|${CURRENT_SEASON}`) ??
        teamIdx.get(`${situationTeam}|${mostRecent.season}`)
      : null;
    const qbTier = (teamCtx?.qb_tier ?? 3) as QBTier;
    const olineRank = teamCtx?.oline_composite_rank ?? 16;

    const seasonStats = rawSeasons.slice(0, 3).map(toSeasonStats);
    const hsmSummary = hsmByPlayer.get(p.player_id);
    const priorShare = priorShareFor(p.position as Position, mostRecent);
    const selfThreatVet = bucketThreat(
      curve,
      p.position as Position,
      pickByGsis.get(p.player_id) ?? null,
      p.draft_round,
    );
    const rookieDisplacementMult = displacementFor(
      p.position as Position,
      p.current_team ?? mostRecent.team,
      priorShare,
      p.player_id,
      selfThreatVet,
    );

    for (const fmt of FORMATS) {
      const input: DPVInput = {
        profile: {
          playerId: p.player_id,
          name: p.name,
          position: p.position as Position,
          age,
        },
        seasons: seasonStats,
        opportunity: {
          snapSharePct: mostRecent.snap_share_pct ?? 0,
          targetSharePct: mostRecent.target_share_pct ?? undefined,
          opportunitySharePct: mostRecent.opportunity_share_pct ?? undefined,
          teamVacatedTargetPct: 0,
          projectedAbsorptionRate: 0,
        },
        situation: {
          teamOLineCompositeRank: olineRank,
          qbTier,
          qbTierPrevious: qbTier,
          qbTransition: "STABLE",
        },
        scoringFormat: fmt,
        rookieDisplacementMult,
        precomputedHSM: hsmSummary
          ? {
              meanNextPPG: hsmSummary.meanNextPPG,
              medianNextPPG: hsmSummary.medianNextPPG,
              n: hsmSummary.n,
              projectedPPG: hsmSummary.projectedPPG,
              proj1: hsmSummary.proj1,
              proj2: hsmSummary.proj2,
              proj3: hsmSummary.proj3,
              n1: hsmSummary.n1,
              n2: hsmSummary.n2,
              n3: hsmSummary.n3,
            }
          : undefined,
      };

      const r = calculateDPV(input);
      prelim[fmt].push({
        playerId: p.player_id,
        position: p.position as Position,
        input,
        preDPV: r.dpv,
      });
    }
    computed++;
  }

  console.log(
    `  computed: ${computed}, rookie priors: ${priored}, skipped: ${skipped}`,
  );

  console.log("Ranking by position and re-running with scarcity...");
  const ranked: Array<{
    player_id: string;
    scoring_format: ScoringFormat;
    dpv: number;
    tier: string;
    breakdown: unknown;
  }> = [];

  for (const fmt of FORMATS) {
    const byPos = new Map<Position, Prelim[]>();
    for (const p of prelim[fmt]) {
      const arr = byPos.get(p.position) ?? [];
      arr.push(p);
      byPos.set(p.position, arr);
    }
    for (const [, arr] of byPos) {
      arr.sort((a, b) => b.preDPV - a.preDPV);
      arr.forEach((entry, i) => {
        const positionRank = i + 1;
        const finalResult = calculateDPV({ ...entry.input, positionRank });
        ranked.push({
          player_id: entry.playerId,
          scoring_format: fmt,
          dpv: finalResult.dpv,
          tier: finalResult.tier,
          breakdown: finalResult.breakdown,
        });
      });
    }
  }

  // Merge rookie priors into the ranked set. They're ranked by prior DPV
  // inside each position alongside veterans so positional tier ordering is
  // consistent (rookie R1 RB slots in among mid-tier RB1/2s, etc.).
  const combined = [...ranked, ...priorSnapshots];

  console.log("Writing dpv_snapshots...");
  const BATCH = 500;
  for (let i = 0; i < combined.length; i += BATCH) {
    const chunk = combined.slice(i, i + BATCH);
    const { error } = await sb
      .from("dpv_snapshots")
      .upsert(chunk, { onConflict: "player_id,scoring_format" });
    if (error) {
      console.error("Upsert error:", error);
      process.exit(1);
    }
  }
  console.log(`  wrote ${combined.length} snapshots`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
