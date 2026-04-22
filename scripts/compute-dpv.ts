import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import { calculateDPV } from "../src/lib/dpv/dpv";
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
const CURRENT_SEASON = 2025;

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

  const byPlayer = new Map<string, typeof seasons>();
  for (const s of seasons) {
    const arr = byPlayer.get(s.player_id) ?? [];
    arr.push(s);
    byPlayer.set(s.player_id, arr);
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
  let skipped = 0;

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

    const rawSeasons = (byPlayer.get(p.player_id) ?? [])
      .filter((s) => s.games_played >= 7)
      .sort((a, b) => b.season - a.season);

    if (rawSeasons.length === 0) {
      skipped++;
      continue;
    }

    const mostRecent = rawSeasons[0];
    const teamCtx = mostRecent.team
      ? teamIdx.get(`${mostRecent.team}|${mostRecent.season}`)
      : null;
    const qbTier = (teamCtx?.qb_tier ?? 3) as QBTier;
    const olineRank = teamCtx?.oline_composite_rank ?? 16;

    const seasonStats = rawSeasons.slice(0, 3).map(toSeasonStats);

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

  console.log(`  computed: ${computed}, skipped: ${skipped}`);

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

  console.log("Writing dpv_snapshots...");
  const BATCH = 500;
  for (let i = 0; i < ranked.length; i += BATCH) {
    const chunk = ranked.slice(i, i + BATCH);
    const { error } = await sb
      .from("dpv_snapshots")
      .upsert(chunk, { onConflict: "player_id,scoring_format" });
    if (error) {
      console.error("Upsert error:", error);
      process.exit(1);
    }
  }
  console.log(`  wrote ${ranked.length} snapshots`);
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
