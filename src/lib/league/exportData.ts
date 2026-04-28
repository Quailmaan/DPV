// Data loader + CSV builders for the Pro-only league export endpoints.
//
// The /league/[id] page already does most of this shaping in its server
// component, but lifting that exact code out would couple the page
// render to the export endpoint and require dragging the report-card +
// trade-finder pipelines along for the ride. The export endpoints don't
// need verdicts or trade ideas — just the rankings, the focused-team
// roster, and the free-agent board. So we re-derive the lighter slice
// here and keep the page's heavier pipeline intact.
//
// Returns null for missing leagues so callers can map that to a 404.

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildMarketDeltaMap } from "@/lib/dpv/marketDelta";
import {
  computeSellWindow,
  type Position as SellWindowPosition,
  type SellWindow,
} from "@/lib/dpv/sellWindow";
import type { ScoringFormat } from "@/lib/dpv/types";
import { buildCsv } from "@/lib/csv";

type Snap = {
  player_id: string;
  dpv: number;
  tier: string;
  players: {
    name: string;
    position: string;
    current_team: string | null;
    birthdate: string | null;
  } | null;
};

export type RosterSummary = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  totalDpv: number;
  byPos: Record<"QB" | "RB" | "WR" | "TE", number>;
  topPlayerName: string | null;
  topPlayerDpv: number;
};

export type ExportContext = {
  league: {
    league_id: string;
    name: string;
    season: string;
    scoring_format: ScoringFormat;
    synced_at: string;
  };
  rosters: Array<{
    league_id: string;
    roster_id: number;
    owner_display_name: string | null;
    team_name: string | null;
    player_ids: string[];
  }>;
  snapMap: Map<string, Snap>;
  summaries: RosterSummary[];
  sellWindowByPlayer: Map<string, SellWindow | null>;
  freeAgents: Snap[];
};

// Fetch + reshape everything the CSVs need for a single league. The
// caller has already verified the user owns the league (or is admin) —
// we don't reauthorize here, just shape the data.
export async function loadExportContext(
  sb: SupabaseClient,
  leagueId: string,
): Promise<ExportContext | null> {
  const leagueRes = await sb
    .from("leagues")
    .select("league_id, name, season, scoring_format, synced_at")
    .eq("league_id", leagueId)
    .maybeSingle();
  if (leagueRes.error || !leagueRes.data) return null;
  const league = leagueRes.data as ExportContext["league"];

  const [rostersRes, snapshotsRes, marketRes] = await Promise.all([
    sb
      .from("league_rosters")
      .select("*")
      .eq("league_id", leagueId)
      .order("roster_id", { ascending: true }),
    sb
      .from("dpv_snapshots")
      .select(
        "player_id, dpv, tier, players(name, position, current_team, birthdate)",
      )
      .eq("scoring_format", league.scoring_format)
      .order("dpv", { ascending: false }),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", league.scoring_format)
      .eq("source", "fantasycalc"),
  ]);

  const rosters = (rostersRes.data ?? []) as ExportContext["rosters"];
  const snapshots = (snapshotsRes.data ?? []) as unknown as Snap[];
  const marketRows = (marketRes.data ?? []) as Array<{
    player_id: string;
    market_value_normalized: number | null;
  }>;

  const snapMap = new Map<string, Snap>();
  for (const s of snapshots) snapMap.set(s.player_id, s);

  const allRosteredIds = new Set<string>();
  for (const r of rosters) for (const pid of r.player_ids) allRosteredIds.add(pid);

  const marketByPid = new Map<string, number>();
  for (const m of marketRows) {
    if (m.market_value_normalized !== null) {
      marketByPid.set(m.player_id, Number(m.market_value_normalized));
    }
  }
  const marketDeltaInput = snapshots
    .map((s) => {
      if (!s.players) return null;
      return {
        id: s.player_id,
        position: s.players.position,
        dpv: Number(s.dpv),
        market: marketByPid.get(s.player_id) ?? null,
      };
    })
    .filter((x): x is {
      id: string;
      position: string;
      dpv: number;
      market: number | null;
    } => x !== null);
  const marketDeltaMap = buildMarketDeltaMap(marketDeltaInput);

  // Sell-window per rostered player. Free-agent windows aren't shown
  // anywhere on the site so we skip them — saves a chunk of work on
  // larger leagues.
  const sellWindowByPlayer = new Map<string, SellWindow | null>();
  for (const r of rosters) {
    for (const pid of r.player_ids) {
      if (sellWindowByPlayer.has(pid)) continue;
      const s = snapMap.get(pid);
      if (!s || !s.players) {
        sellWindowByPlayer.set(pid, null);
        continue;
      }
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") {
        sellWindowByPlayer.set(pid, null);
        continue;
      }
      const bd = s.players.birthdate;
      const ageYears = bd
        ? (Date.now() - new Date(bd).getTime()) /
          (365.25 * 24 * 3600 * 1000)
        : null;
      sellWindowByPlayer.set(
        pid,
        computeSellWindow({
          position: pos as SellWindowPosition,
          age: ageYears,
          dpv: Number(s.dpv),
          marketDelta: marketDeltaMap.get(pid) ?? null,
        }),
      );
    }
  }

  const summaries: RosterSummary[] = rosters.map((r) => {
    const byPos: Record<"QB" | "RB" | "WR" | "TE", number> = {
      QB: 0,
      RB: 0,
      WR: 0,
      TE: 0,
    };
    let total = 0;
    let topPlayer: Snap | null = null;
    for (const pid of r.player_ids) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position as "QB" | "RB" | "WR" | "TE";
      if (!(pos in byPos)) continue;
      byPos[pos] += s.dpv;
      total += s.dpv;
      if (!topPlayer || s.dpv > topPlayer.dpv) topPlayer = s;
    }
    return {
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
      totalDpv: total,
      byPos,
      topPlayerName: (topPlayer as Snap | null)?.players?.name ?? null,
      topPlayerDpv: (topPlayer as Snap | null)?.dpv ?? 0,
    };
  });
  summaries.sort((a, b) => b.totalDpv - a.totalDpv);

  // Free agents — same 200-cap as the page so the CSV reflects what the
  // user sees on screen. Larger lists drift quickly anyway.
  const freeAgents = snapshots
    .filter((s) => !allRosteredIds.has(s.player_id))
    .slice(0, 200);

  return {
    league,
    rosters,
    snapMap,
    summaries,
    sellWindowByPlayer,
    freeAgents,
  };
}

// ----------------- builders -----------------

function ageFrom(bd: string | null): string {
  if (!bd) return "";
  const y =
    (Date.now() - new Date(bd).getTime()) / (365.25 * 24 * 3600 * 1000);
  return y.toFixed(1);
}

export function buildRankingsCsv(ctx: ExportContext): string {
  const headers = [
    "Rank",
    "Roster ID",
    "Owner",
    "Team Name",
    "Total PYV",
    "QB PYV",
    "RB PYV",
    "WR PYV",
    "TE PYV",
    "Top Player",
    "Top Player PYV",
  ];
  const rows = ctx.summaries.map((s, i) => [
    i + 1,
    s.rosterId,
    s.ownerName,
    s.teamName ?? "",
    Math.round(s.totalDpv),
    Math.round(s.byPos.QB),
    Math.round(s.byPos.RB),
    Math.round(s.byPos.WR),
    Math.round(s.byPos.TE),
    s.topPlayerName ?? "",
    s.topPlayerDpv ? Math.round(s.topPlayerDpv) : "",
  ]);
  return buildCsv(headers, rows);
}

export function buildTeamRosterCsv(
  ctx: ExportContext,
  rosterId: number,
): string | null {
  const roster = ctx.rosters.find((r) => r.roster_id === rosterId);
  if (!roster) return null;

  const headers = [
    "Player",
    "Position",
    "NFL Team",
    "Age",
    "PYV",
    "Tier",
    "Sell Window",
    "Sell Reason",
  ];
  const rows = roster.player_ids
    .map((pid) => ctx.snapMap.get(pid))
    .filter((s): s is Snap => !!s && !!s.players)
    .sort((a, b) => b.dpv - a.dpv)
    .map((s) => {
      const sw = ctx.sellWindowByPlayer.get(s.player_id) ?? null;
      return [
        s.players!.name,
        s.players!.position,
        s.players!.current_team ?? "",
        ageFrom(s.players!.birthdate),
        s.dpv,
        s.tier,
        sw?.label ?? "",
        sw?.reason ?? "",
      ];
    });
  return buildCsv(headers, rows);
}

export function buildFreeAgentsCsv(ctx: ExportContext): string {
  const headers = ["Player", "Position", "NFL Team", "Age", "PYV", "Tier"];
  const rows = ctx.freeAgents
    .filter((s) => !!s.players)
    .map((s) => [
      s.players!.name,
      s.players!.position,
      s.players!.current_team ?? "",
      ageFrom(s.players!.birthdate),
      s.dpv,
      s.tier,
    ]);
  return buildCsv(headers, rows);
}

// Slug-friendly version of the league name for filenames. "My League!"
// → "my-league". Falls back to the league_id when the name is empty
// after stripping.
export function leagueSlug(name: string, leagueId: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || leagueId;
}
