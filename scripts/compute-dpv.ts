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

// Match the /rookies page name normalization so the consensus-match gate
// on rookie priors uses the same join key.
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

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

  console.log("Loading prospect_consensus names...");
  const prospectRows = await fetchAll<{ name: string; draft_year: number | null }>(
    "prospect_consensus",
  );
  // Only gate against names from the incoming + recently-drafted windows we
  // actually emit priors for. A cross-class normalized-name collision is
  // unlikely, and this keeps the gate scoped to relevant classes.
  const consensusNames = new Set<string>();
  for (const pr of prospectRows) {
    if (
      pr.draft_year !== null &&
      pr.draft_year >= CURRENT_SEASON - 2 &&
      pr.draft_year <= INCOMING_CLASS_YEAR
    ) {
      consensusNames.add(normalizeName(pr.name));
    }
  }
  console.log(`  ${consensusNames.size} normalized consensus names in window`);

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

  // ── QB role-confidence factors ──────────────────────────────────────
  //
  // The ≥7g qualifying filter in BPS hides backup seasons — a 17g
  // starter year followed by 1g + 0g looks identical to a starter who
  // got injured. Combined with QB opportunity being hard-coded to 1.0
  // (src/lib/dpv/opportunity.ts:14), the model has no way to tell a
  // current backup from a starter without these signals.
  //
  // Two separate factors, both ≤ 1.0, both applied multiplicatively
  // inside the engine:
  //
  //   A. starterRate — fraction of last 2 seasons spent as the team's
  //      starter (snap_share ≥ 60% AND ≥ 3g per season). Catches career
  //      backups whose only qualifying BPS season is a stale starter
  //      year (Howell '23, Dobbs '23 Passtronaut tour).
  //
  //   B. depthChart — penalty when another QB on the player's
  //      current_team has stronger 2-yr starter evidence + a draft-
  //      capital bonus for recent R1/R2 picks. Catches displaced
  //      starters who signed elsewhere as the QB2 (Tua → ATL behind
  //      a recent R1 in Penix).

  const QB_LOOKBACK_SEASONS = 2;
  const QB_STARTER_SNAP_PCT = 60;
  const QB_STARTER_MIN_GAMES = 3;

  // Count games where the QB clearly held the starting job. snap_share is
  // stored as a percent (e.g. 95.4), so the threshold is in percent terms.
  function qbStarterGames(
    rows: typeof seasons,
    fromSeason: number,
    toSeason: number,
  ): number {
    let games = 0;
    for (const r of rows) {
      if (r.season < fromSeason || r.season > toSeason) continue;
      const snap = r.snap_share_pct ?? 0;
      if (snap >= QB_STARTER_SNAP_PCT && r.games_played >= QB_STARTER_MIN_GAMES) {
        games += r.games_played;
      }
    }
    return games;
  }

  function qbStarterRateMultFor(
    p: (typeof players)[number],
    rows: typeof seasons,
  ): number {
    if (p.position !== "QB") return 1.0;
    // Window is the last QB_LOOKBACK_SEASONS completed seasons. With
    // CURRENT_SEASON = most-recently-completed (per constants.ts), that's
    // [CURRENT_SEASON - 1, CURRENT_SEASON]. Floor by draft_year so a recent
    // rookie isn't penalized for seasons before they entered the league.
    const draftYear = p.draft_year ?? 0;
    const fromSeason = Math.max(
      CURRENT_SEASON - QB_LOOKBACK_SEASONS + 1,
      draftYear,
    );
    const toSeason = CURRENT_SEASON;
    const seasonsInWindow = toSeason - fromSeason + 1;
    if (seasonsInWindow <= 0) return 1.0;
    const possibleGames = seasonsInWindow * 17;
    const games = qbStarterGames(rows, fromSeason, toSeason);
    const rate = games / possibleGames;
    if (rate >= 0.5) return 1.0;
    if (rate <= 0.1) return 0.55;
    // Linear ramp 0.10 → 0.50 maps 0.55 → 1.0
    return 0.55 + ((rate - 0.1) / 0.4) * (1.0 - 0.55);
  }

  // Pre-compute depth-chart penalty per QB. R1/R2 picks from the last 3
  // draft classes get a starter-equivalent bonus even with limited NFL
  // snaps — a vet signing behind a young R1 (Penix-style) should be
  // flagged as the QB2 even if the rookie has fewer real starts than
  // the vet's prior team did. A 3-year window covers (CURRENT_SEASON-2)
  // through (CURRENT_SEASON), so a 2024 R1 still registers as franchise
  // capital when ranking 2026: their team is committed.
  const QB_R1_DRAFT_BONUS = 17;
  const QB_R2_DRAFT_BONUS = 8;
  const QB_DRAFT_BONUS_LOOKBACK = 2; // years before CURRENT_SEASON
  const QB_DEPTH_MIN_TEAM_MAX = 12; // need clear evidence the other guy starts
  const QB_DEPTH_GAP = 5; // I'm in the running if within 5 games of leader
  const QB_DEPTH_PENALTY = 0.5;

  type QBScore = { player_id: string; score: number };
  const qbScoresByTeam = new Map<string, QBScore[]>();
  for (const p of players) {
    if (p.position !== "QB" || !p.current_team) continue;
    const rows = byPlayer.get(p.player_id) ?? [];
    let score = qbStarterGames(
      rows,
      CURRENT_SEASON - QB_LOOKBACK_SEASONS + 1,
      CURRENT_SEASON,
    );
    if (
      (p.draft_year ?? 0) >= CURRENT_SEASON - QB_DRAFT_BONUS_LOOKBACK &&
      p.draft_round !== null
    ) {
      if (p.draft_round === 1) score += QB_R1_DRAFT_BONUS;
      else if (p.draft_round === 2) score += QB_R2_DRAFT_BONUS;
    }
    const arr = qbScoresByTeam.get(p.current_team) ?? [];
    arr.push({ player_id: p.player_id, score });
    qbScoresByTeam.set(p.current_team, arr);
  }
  const qbDepthMultByPlayer = new Map<string, number>();
  for (const arr of qbScoresByTeam.values()) {
    if (arr.length <= 1) {
      for (const x of arr) qbDepthMultByPlayer.set(x.player_id, 1.0);
      continue;
    }
    const teamMax = Math.max(...arr.map((x) => x.score));
    for (const x of arr) {
      if (teamMax < QB_DEPTH_MIN_TEAM_MAX || x.score >= teamMax - QB_DEPTH_GAP) {
        qbDepthMultByPlayer.set(x.player_id, 1.0);
      } else {
        qbDepthMultByPlayer.set(x.player_id, QB_DEPTH_PENALTY);
      }
    }
  }

  // Recency floor for opportunity inputs. By default we read the most-recent
  // season's opportunity metrics, but when an established player (3+ qualifying
  // seasons in the last 3 yrs) has a disrupted latest season (<14 games), use
  // a games-weighted blend across the qualifying window instead. This stops a
  // single injury year from collapsing the opportunity multiplier and tanking
  // DPV for a player whose role hasn't actually changed.
  //
  // Real-world example: Garrett Wilson 2022-2024 averaged ~27% target share
  // across 17g seasons; his disrupted 2025 (7g, 12.5% tgt share) crashed his
  // DPV from starter-caliber into bench territory despite no role change.
  // The blend recovers the trajectory and tags him correctly as a starter
  // for landing-spot depth-chart analysis.
  function buildOpportunityInputs(
    rawSeasons: ReadonlyArray<(typeof seasons)[number]>,
    mostRecent: (typeof seasons)[number],
  ): {
    snapSharePct: number;
    targetSharePct: number | undefined;
    opportunitySharePct: number | undefined;
    teamVacatedTargetPct: number;
    projectedAbsorptionRate: number;
  } {
    const qualifying = rawSeasons
      .filter((s) => s.season >= CURRENT_SEASON - 3)
      .slice(0, 3);
    const useBlend =
      qualifying.length >= 3 && (mostRecent.games_played ?? 0) < 14;

    if (!useBlend) {
      return {
        snapSharePct: mostRecent.snap_share_pct ?? 0,
        targetSharePct: mostRecent.target_share_pct ?? undefined,
        opportunitySharePct: mostRecent.opportunity_share_pct ?? undefined,
        teamVacatedTargetPct: 0,
        projectedAbsorptionRate: 0,
      };
    }

    // Weight each metric only by the games where it was actually reported
    // (a season with null snap_share but valid target_share shouldn't drag
    // the snap-share blend toward zero).
    let snapSum = 0;
    let snapGames = 0;
    let targetSum = 0;
    let targetGames = 0;
    let oppSum = 0;
    let oppGames = 0;
    for (const s of qualifying) {
      const g = s.games_played ?? 0;
      if (g <= 0) continue;
      if (s.snap_share_pct !== null) {
        snapSum += s.snap_share_pct * g;
        snapGames += g;
      }
      if (s.target_share_pct !== null) {
        targetSum += s.target_share_pct * g;
        targetGames += g;
      }
      if (s.opportunity_share_pct !== null) {
        oppSum += s.opportunity_share_pct * g;
        oppGames += g;
      }
    }
    return {
      snapSharePct:
        snapGames > 0 ? snapSum / snapGames : mostRecent.snap_share_pct ?? 0,
      targetSharePct:
        targetGames > 0
          ? targetSum / targetGames
          : mostRecent.target_share_pct ?? undefined,
      opportunitySharePct:
        oppGames > 0
          ? oppSum / oppGames
          : mostRecent.opportunity_share_pct ?? undefined,
      teamVacatedTargetPct: 0,
      projectedAbsorptionRate: 0,
    };
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
      // Gate: require real draft capital OR a prospect_consensus match.
      // nflverse backfills draft_year from entry_year (practice-squad /
      // futures signings), which floods /rookies and position rankings
      // with non-prospects when draft_round is null. If a UDFA was tracked
      // as a prospect (their name appears in prospect_consensus), they
      // still make it through.
      if (
        p.draft_round === null &&
        !consensusNames.has(normalizeName(p.name))
      ) {
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
    // Skip retired players — defined as no NFL action (qualifying or not)
    // within the last 2 seasons. The skip used to look at mostRecent (the
    // ≥7g-filtered list), which incorrectly retired QBs whose only recent
    // games were as backups — Sam Howell's 2024 was 1g for SEA, Dobbs'
    // 2025 was 4g for NE. Both got frozen at their 2023 starter-year
    // scores instead of being penalized as current backups. Use the
    // unfiltered last season so they flow through and qbStarterRateMult
    // can do its job.
    const lastAnySeason = allSeasons.reduce(
      (m, s) => (s.season > m ? s.season : m),
      0,
    );
    if (lastAnySeason < CURRENT_SEASON - 1) {
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

    // QB role-confidence — only meaningful for QBs. For other positions
    // both default to 1.0.
    const qbStarterRateMult =
      p.position === "QB" ? qbStarterRateMultFor(p, rawSeasons) : 1.0;
    const qbDepthChartMult =
      p.position === "QB"
        ? qbDepthMultByPlayer.get(p.player_id) ?? 1.0
        : 1.0;

    for (const fmt of FORMATS) {
      const input: DPVInput = {
        profile: {
          playerId: p.player_id,
          name: p.name,
          position: p.position as Position,
          age,
        },
        seasons: seasonStats,
        opportunity: buildOpportunityInputs(rawSeasons, mostRecent),
        situation: {
          teamOLineCompositeRank: olineRank,
          qbTier,
          qbTierPrevious: qbTier,
          qbTransition: "STABLE",
        },
        scoringFormat: fmt,
        rookieDisplacementMult,
        qbStarterRateMult,
        qbDepthChartMult,
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

  // Cleanup pass: delete snapshots for players we didn't compute this run.
  // The script only upserts, so without this any player who retires (or is
  // otherwise dropped from the active set) keeps their last computed DPV
  // forever — Tom Brady was still showing up at DPV 3395 long after he hung
  // it up. The skip-set is "every player_id present in dpv_snapshots that
  // isn't in the freshly computed `combined`."
  const writtenIds = new Set(combined.map((c) => c.player_id));
  const existingIds = new Set<string>();
  {
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await sb
        .from("dpv_snapshots")
        .select("player_id")
        .range(offset, offset + PAGE - 1);
      if (error) {
        console.error("Cleanup scan error:", error);
        process.exit(1);
      }
      if (!data || data.length === 0) break;
      for (const r of data) existingIds.add(r.player_id);
      if (data.length < PAGE) break;
    }
  }
  const stalePlayerIds = [...existingIds].filter((id) => !writtenIds.has(id));
  // Guard against a catastrophic run wiping everyone — refuse if more than
  // half the existing player set would be deleted. The first run after
  // adding cleanup will hit ~40% (years of accumulated retired-player
  // backlog); after that it should be a handful per offseason.
  const STALE_FRACTION_LIMIT = 0.5;
  if (
    existingIds.size > 0 &&
    stalePlayerIds.length / existingIds.size > STALE_FRACTION_LIMIT
  ) {
    console.error(
      `Refusing to delete ${stalePlayerIds.length}/${existingIds.size} (${(
        (stalePlayerIds.length / existingIds.size) *
        100
      ).toFixed(1)}%) of snapshots — that's above the ${(
        STALE_FRACTION_LIMIT * 100
      ).toFixed(0)}% safety threshold. Investigate the compute step before re-running.`,
    );
    process.exit(1);
  }
  if (stalePlayerIds.length > 0) {
    // Print a sample of who's getting cut so a human can spot-check.
    const samplePlayers = await sb
      .from("players")
      .select("player_id, name, position, current_team")
      .in("player_id", stalePlayerIds.slice(0, 20));
    if (samplePlayers.data) {
      console.log("Sample of stale players to delete:");
      for (const p of samplePlayers.data) {
        console.log(`  ${p.position} ${p.name} (team ${p.current_team ?? "—"})`);
      }
    }
    console.log(`Deleting ${stalePlayerIds.length} stale player snapshots...`);
    for (let i = 0; i < stalePlayerIds.length; i += BATCH) {
      const chunk = stalePlayerIds.slice(i, i + BATCH);
      const { error } = await sb
        .from("dpv_snapshots")
        .delete()
        .in("player_id", chunk);
      if (error) {
        console.error("Cleanup delete error:", error);
        process.exit(1);
      }
    }
    console.log(`  deleted ${stalePlayerIds.length} stale player ids`);
  } else {
    console.log("No stale snapshots to clean up.");
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
