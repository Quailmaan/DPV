import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScoringFormat } from "./types";

// DPV trajectory derived from dpv_history. Used by the sell-window
// indicator (Phase 2 of the value-trend feature set) and by the future
// per-player trend chart.
//
// Two questions this module answers:
//   1. What did this player's DPV look like ~N days ago? (closest snapshot)
//   2. What's the % change from then to now?
//
// The "closest" is necessary because the nightly compute may skip days
// (script failure, retired-player cleanup, etc.) — we don't require an
// exact-day match, just the nearest snapshot within a tolerance window.

export type DpvDataPoint = {
  snapshotDate: string; // YYYY-MM-DD
  dpv: number;
};

export type DpvTrajectory = {
  current: number;
  // 30-day change. Null when we don't have enough history yet (the
  // typical state for the first ~month after deploy). Callers should
  // gracefully degrade — the sell-window score reweights to the other
  // inputs when these are null.
  change30d: { from: number; pct: number; date: string } | null;
  change180d: { from: number; pct: number; date: string } | null;
};

// How far either side of the target lookback window we'll accept a
// snapshot. Set to ~7 days so a single-day compute outage doesn't blank
// the indicator, but a multi-week gap does (because at that point the
// "30-day delta" isn't really a 30-day delta anymore).
const SNAPSHOT_TOLERANCE_DAYS = 7;

function daysAgoIso(now: Date, days: number): string {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.abs(da - db) / (1000 * 60 * 60 * 24);
}

// Query helper: pull every history row for a player + format, sorted
// newest-first. Used as the input to `computeTrajectory`. Kept as a
// separate function so callers can batch the read across many players
// in a single query if they need to (the report-card and sell-window
// indicator both want trajectories in bulk).
export async function loadHistoryForPlayer(
  sb: SupabaseClient,
  playerId: string,
  scoringFormat: ScoringFormat,
): Promise<DpvDataPoint[]> {
  const { data, error } = await sb
    .from("dpv_history")
    .select("snapshot_date, dpv")
    .eq("player_id", playerId)
    .eq("scoring_format", scoringFormat)
    .order("snapshot_date", { ascending: false });
  if (error || !data) return [];
  return data.map((r) => ({
    snapshotDate: r.snapshot_date as string,
    dpv: r.dpv as number,
  }));
}

// Same as above but for many players at once. Returns a Map keyed by
// player_id whose value is the descending-by-date row list. Callers
// hand it to `computeTrajectory` per-player to get the deltas.
export async function loadHistoryForPlayers(
  sb: SupabaseClient,
  playerIds: string[],
  scoringFormat: ScoringFormat,
): Promise<Map<string, DpvDataPoint[]>> {
  if (playerIds.length === 0) return new Map();
  const out = new Map<string, DpvDataPoint[]>();
  // Supabase's .in() can handle ~1000 ids per call; chunk to be safe.
  const CHUNK = 500;
  for (let i = 0; i < playerIds.length; i += CHUNK) {
    const slice = playerIds.slice(i, i + CHUNK);
    const { data, error } = await sb
      .from("dpv_history")
      .select("player_id, snapshot_date, dpv")
      .in("player_id", slice)
      .eq("scoring_format", scoringFormat)
      .order("snapshot_date", { ascending: false });
    if (error || !data) continue;
    for (const r of data as Array<{
      player_id: string;
      snapshot_date: string;
      dpv: number;
    }>) {
      const arr = out.get(r.player_id) ?? [];
      arr.push({ snapshotDate: r.snapshot_date, dpv: r.dpv });
      out.set(r.player_id, arr);
    }
  }
  return out;
}

// Find the snapshot closest to `targetDateIso` within the tolerance
// window. Returns null if no row is close enough.
function closestSnapshot(
  history: DpvDataPoint[],
  targetDateIso: string,
  toleranceDays: number,
): DpvDataPoint | null {
  let best: DpvDataPoint | null = null;
  let bestDist = Infinity;
  for (const row of history) {
    const dist = daysBetween(row.snapshotDate, targetDateIso);
    if (dist < bestDist) {
      best = row;
      bestDist = dist;
    }
  }
  if (!best || bestDist > toleranceDays) return null;
  return best;
}

// Compute 30-day and 180-day deltas from a player's history. Pass
// `now` so callers can pin a deterministic clock in tests / scripts;
// defaults to the current wall clock.
export function computeTrajectory(
  history: DpvDataPoint[],
  now: Date = new Date(),
): DpvTrajectory | null {
  if (history.length === 0) return null;
  // Most recent snapshot is the "current" value — even if dpv_snapshots
  // happens to be slightly fresher, we use history's latest so the
  // delta math is internally consistent.
  const current = history[0].dpv;

  const target30 = daysAgoIso(now, 30);
  const target180 = daysAgoIso(now, 180);

  const past30 = closestSnapshot(history, target30, SNAPSHOT_TOLERANCE_DAYS);
  // 180-day tolerance is wider — once you're 6 months back, a 2-week
  // gap doesn't change the meaning of the comparison.
  const past180 = closestSnapshot(history, target180, SNAPSHOT_TOLERANCE_DAYS * 2);

  const pctChange = (from: number) =>
    from === 0 ? 0 : ((current - from) / from) * 100;

  return {
    current,
    change30d: past30
      ? {
          from: past30.dpv,
          pct: Number(pctChange(past30.dpv).toFixed(1)),
          date: past30.snapshotDate,
        }
      : null,
    change180d: past180
      ? {
          from: past180.dpv,
          pct: Number(pctChange(past180.dpv).toFixed(1)),
          date: past180.snapshotDate,
        }
      : null,
  };
}
