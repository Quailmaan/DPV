/**
 * In-memory preview of how adding/removing the efficiency multiplier
 * shifts dynasty rankings. Works regardless of whether compute-dpv has
 * been run with the new code yet:
 *
 *   - If current dpv_snapshots include `efficiencyMultiplier` in
 *     breakdown (compute-dpv was run with new code), this prints
 *     "what the ranks would be if we removed efficiency".
 *   - If they don't (still on old code), this prints "what the ranks
 *     would be if we added efficiency".
 *
 * Either way, you see climbers/droppers without writing anything to
 * the DB. Useful for previewing the algorithm change before running
 * compute-dpv against prod.
 *
 * Math: every dpv_snapshots row stores enough breakdown components
 * (dpvRaw, dpvProjected, dpvFinal, hsmBlendWeight, marketBlendWeight,
 * scarcityMultiplier, rookieDisplacementMult) to reverse-engineer
 * the hidden inputs (projectedPPG, market value) and re-run the chain
 * with a different efficiency multiplier. We assume scarcity stays
 * fixed — a real recompute would re-rank and shift scarcity slightly,
 * but the effect on this preview is small (scarcity is a smooth
 * function of position rank).
 *
 * Run: `npx tsx scripts/preview-efficiency-impact.ts`
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";
import { efficiencyMultiplier } from "../src/lib/dpv/efficiency";
import type { Position } from "../src/lib/dpv/types";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase env vars");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

const FORMAT = "HALF_PPR";
const DPV_SCALE_CONSTANT = 380;
const DPV_MAX = 10000;
const TOP_N = 12;

type Breakdown = {
  dpvRaw: number;
  dpvProjected: number;
  dpvFinal: number;
  hsmBlendWeight: number;
  marketBlendWeight: number;
  scarcityMultiplier: number;
  rookieDisplacementMult: number;
  efficiencyMultiplier?: number;
};

type Snapshot = {
  player_id: string;
  scoring_format: string;
  dpv: number;
  breakdown: Breakdown;
};

type AdvancedRow = {
  player_id: string;
  season: number;
  passing_epa_per_dropback: number | null;
  rushing_epa_per_carry: number | null;
  receiving_epa_per_target: number | null;
  dropbacks: number | null;
  carries: number | null;
  targets: number | null;
};

type Player = { player_id: string; name: string; position: Position };

async function fetchAll<T>(
  table: string,
  columns: string,
  filter?: (q: ReturnType<ReturnType<typeof sb.from>["select"]>) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    let q = sb.from(table).select(columns) as ReturnType<
      ReturnType<typeof sb.from>["select"]
    >;
    if (filter) q = filter(q) as typeof q;
    const { data, error } = await q.range(start, start + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

// Recompute the final normalized DPV given an alternate efficiency
// multiplier. Reverse-engineers projectedPPG and market value from
// the stored breakdown, then re-runs the modifier chain.
//
// Returns null when the breakdown is missing fields needed for the
// reversal (older dpv_snapshots rows pre-date the current shape).
// Caller skips those players from the diff — better than letting
// NaN values silently poison subsequent rank sorts.
function recompute(
  b: Breakdown,
  oldEff: number,
  newEff: number,
): number | null {
  // Strict input validation. ANY non-finite stored field means we
  // can't trust the math downstream — drop and let the caller skip.
  if (
    !b ||
    !Number.isFinite(b.dpvRaw) ||
    !Number.isFinite(b.dpvProjected) ||
    !Number.isFinite(b.dpvFinal) ||
    !Number.isFinite(b.hsmBlendWeight) ||
    !Number.isFinite(b.marketBlendWeight) ||
    !Number.isFinite(b.scarcityMultiplier) ||
    !Number.isFinite(b.rookieDisplacementMult) ||
    !Number.isFinite(oldEff) ||
    oldEff === 0 ||
    !Number.isFinite(newEff)
  ) {
    return null;
  }

  // 1. Apply the efficiency ratio to dpvRaw
  const ratio = newEff / oldEff;
  const newDpvRaw = b.dpvRaw * ratio;

  // 2. Recover projectedPPG and re-blend with HSM weight.
  // When hsmBlendWeight === 1, no projection was used; output = dpvRaw.
  let newDpvProjected: number;
  if (b.hsmBlendWeight >= 1 - 1e-9) {
    newDpvProjected = newDpvRaw;
  } else {
    const projectedPPG =
      (b.dpvProjected - b.dpvRaw * b.hsmBlendWeight) / (1 - b.hsmBlendWeight);
    if (!Number.isFinite(projectedPPG)) return null;
    newDpvProjected =
      newDpvRaw * b.hsmBlendWeight + projectedPPG * (1 - b.hsmBlendWeight);
  }

  // 3. Recover market value and re-blend.
  // breakdown.dpvFinal stores the SCALED value (post scarcity + rookie
  // displacement), not the pre-scarcity blend output. Strip the scaling
  // back to recover dpvFinal_pre_scarcity, then reverse the blend.
  const scarcityScale = b.scarcityMultiplier * b.rookieDisplacementMult;
  if (scarcityScale <= 0) return null;
  const dpvFinalPreScarcity = b.dpvFinal / scarcityScale;

  let newDpvFinalPreScarcity: number;
  if (b.marketBlendWeight <= 1e-9) {
    newDpvFinalPreScarcity = newDpvProjected;
  } else {
    const market =
      (dpvFinalPreScarcity - b.dpvProjected * (1 - b.marketBlendWeight)) /
      b.marketBlendWeight;
    if (!Number.isFinite(market)) return null;
    newDpvFinalPreScarcity =
      newDpvProjected * (1 - b.marketBlendWeight) +
      market * b.marketBlendWeight;
  }

  // 4. Re-apply scarcity scaling and normalize.
  const scaled = newDpvFinalPreScarcity * scarcityScale;
  if (!Number.isFinite(scaled)) return null;
  return Math.max(
    0,
    Math.min(DPV_MAX, Math.round(scaled * DPV_SCALE_CONSTANT)),
  );
}

// Pick the position-relevant EPA/opportunity from the most-recent
// advanced-stats row. Mirrors the logic in compute-dpv.ts.
function effForPlayer(
  position: Position,
  adv: AdvancedRow | undefined,
): number {
  if (!adv) return 1.0;
  if (position === "QB") {
    return efficiencyMultiplier("QB", {
      epaPerOpportunity: adv.passing_epa_per_dropback,
      opportunities: adv.dropbacks ?? 0,
    });
  }
  if (position === "RB") {
    return efficiencyMultiplier("RB", {
      epaPerOpportunity: adv.rushing_epa_per_carry,
      opportunities: adv.carries ?? 0,
    });
  }
  return efficiencyMultiplier(position, {
    epaPerOpportunity: adv.receiving_epa_per_target,
    opportunities: adv.targets ?? 0,
  });
}

async function main() {
  console.log("Loading dpv_snapshots, player_advanced_stats, players...");
  const [snapshots, advancedRaw, players] = await Promise.all([
    fetchAll<Snapshot>(
      "dpv_snapshots",
      "player_id,scoring_format,dpv,breakdown",
      (q) =>
        (q as ReturnType<ReturnType<typeof sb.from>["select"]>).eq(
          "scoring_format",
          FORMAT,
        ),
    ),
    fetchAll<AdvancedRow>(
      "player_advanced_stats",
      "player_id,season,passing_epa_per_dropback,rushing_epa_per_carry,receiving_epa_per_target,dropbacks,carries,targets",
    ),
    fetchAll<Player>("players", "player_id,name,position"),
  ]);

  console.log(
    `  ${snapshots.length} snapshots, ${advancedRaw.length} advanced rows, ${players.length} players\n`,
  );

  // Most-recent season per player from advanced stats
  const advByPlayer = new Map<string, AdvancedRow>();
  for (const r of advancedRaw) {
    const ex = advByPlayer.get(r.player_id);
    if (!ex || r.season > ex.season) advByPlayer.set(r.player_id, r);
  }

  const playerById = new Map<string, Player>();
  for (const p of players) playerById.set(p.player_id, p);

  // Detect whether current dpv_snapshots was computed with or without
  // the efficiency multiplier. The new compute-dpv writes
  // breakdown.efficiencyMultiplier; the old one didn't.
  const sample = snapshots.find((s) => s.breakdown);
  const hasEff =
    sample !== undefined &&
    typeof sample.breakdown.efficiencyMultiplier === "number";
  console.log(
    hasEff
      ? "Current dpv_snapshots was computed WITH efficiency. Showing what changes if we REMOVED it.\n"
      : "Current dpv_snapshots was computed WITHOUT efficiency. Showing what changes if we ADD it (= the new algorithm).\n",
  );

  // For each snapshot, compute current DPV (= what's in DB) and
  // alternate DPV (= what it would be under the other algorithm).
  type Computed = {
    player_id: string;
    name: string;
    position: Position;
    oldDpv: number;
    newDpv: number;
    eff: number;
  };
  const computed: Computed[] = [];
  let skippedNoBreakdown = 0;
  let skippedRecomputeFailed = 0;
  for (const s of snapshots) {
    const p = playerById.get(s.player_id);
    if (!p) continue;
    if (!Number.isFinite(s.dpv)) continue;

    const eff = effForPlayer(p.position, advByPlayer.get(s.player_id));

    let oldDpv: number, newDpv: number;
    if (hasEff) {
      const currentEff = s.breakdown?.efficiencyMultiplier ?? 1.0;
      // Short-circuit when efficiency was effectively 1.0× — removing
      // it doesn't change anything, and we don't need to risk the
      // reverse-engineering math on a row whose breakdown might be
      // partial.
      if (Math.abs(currentEff - 1.0) < 1e-9) {
        oldDpv = s.dpv;
        newDpv = s.dpv;
      } else {
        if (!s.breakdown) {
          skippedNoBreakdown++;
          continue;
        }
        const result = recompute(s.breakdown, currentEff, 1.0);
        if (result === null) {
          skippedRecomputeFailed++;
          continue;
        }
        oldDpv = result;
        newDpv = s.dpv;
      }
    } else {
      // Stored DPV used 1.0×. Short-circuit when the new efficiency
      // is also 1.0× (most players have no advanced-stats data) so
      // we don't run the reverse-engineering math unnecessarily.
      if (Math.abs(eff - 1.0) < 1e-9) {
        oldDpv = s.dpv;
        newDpv = s.dpv;
      } else {
        if (!s.breakdown) {
          skippedNoBreakdown++;
          continue;
        }
        oldDpv = s.dpv;
        const result = recompute(s.breakdown, 1.0, eff);
        if (result === null) {
          skippedRecomputeFailed++;
          continue;
        }
        newDpv = result;
      }
    }

    computed.push({
      player_id: s.player_id,
      name: p.name,
      position: p.position,
      oldDpv,
      newDpv,
      eff,
    });
  }
  if (skippedNoBreakdown > 0 || skippedRecomputeFailed > 0) {
    console.log(
      `Skipped ${skippedNoBreakdown} rows missing breakdown, ${skippedRecomputeFailed} where recompute failed.\n`,
    );
  }

  // Per-position rank within both old and new
  for (const pos of ["QB", "RB", "WR", "TE"] as const) {
    const atPos = computed.filter((c) => c.position === pos);
    const oldRanks = new Map<string, number>();
    [...atPos]
      .sort((a, b) => b.oldDpv - a.oldDpv)
      .forEach((c, i) => oldRanks.set(c.player_id, i + 1));
    const newRanks = new Map<string, number>();
    [...atPos]
      .sort((a, b) => b.newDpv - a.newDpv)
      .forEach((c, i) => newRanks.set(c.player_id, i + 1));

    const withDelta = atPos.map((c) => ({
      ...c,
      oldRank: oldRanks.get(c.player_id)!,
      newRank: newRanks.get(c.player_id)!,
      rankDelta: oldRanks.get(c.player_id)! - newRanks.get(c.player_id)!,
      dpvDelta: c.newDpv - c.oldDpv,
    }));

    // Restrict to fantasy-relevant rank window so a backup WR going
    // from #220 to #210 doesn't pollute the climbers list.
    const RANK_WINDOW = { QB: 36, RB: 60, WR: 80, TE: 30 }[pos];
    const inWindow = withDelta.filter(
      (d) => d.oldRank <= RANK_WINDOW || d.newRank <= RANK_WINDOW,
    );

    console.log(
      `=== ${pos} (${atPos.length} total, top ${RANK_WINDOW} window) ===`,
    );

    const climbers = [...inWindow]
      .filter((d) => d.rankDelta > 0)
      .sort((a, b) => b.rankDelta - a.rankDelta)
      .slice(0, TOP_N);
    const droppers = [...inWindow]
      .filter((d) => d.rankDelta < 0)
      .sort((a, b) => a.rankDelta - b.rankDelta)
      .slice(0, TOP_N);

    console.log("  Climbers:");
    if (climbers.length === 0) console.log("    (none)");
    for (const d of climbers) {
      const arrow = `#${d.oldRank}→#${d.newRank}`.padEnd(11);
      const effPct = `${((d.eff - 1) * 100).toFixed(1)}%`.padStart(7);
      const dpvDelta = `${d.dpvDelta >= 0 ? "+" : ""}${d.dpvDelta}`;
      console.log(
        `    +${String(d.rankDelta).padStart(2)}  ${d.name.padEnd(28)} ${arrow}  eff=${effPct}  PYV ${d.oldDpv}→${d.newDpv} (${dpvDelta})`,
      );
    }

    console.log("  Droppers:");
    if (droppers.length === 0) console.log("    (none)");
    for (const d of droppers) {
      const arrow = `#${d.oldRank}→#${d.newRank}`.padEnd(11);
      const effPct = `${((d.eff - 1) * 100).toFixed(1)}%`.padStart(7);
      const dpvDelta = `${d.dpvDelta >= 0 ? "+" : ""}${d.dpvDelta}`;
      console.log(
        `    ${String(d.rankDelta).padStart(3)}  ${d.name.padEnd(28)} ${arrow}  eff=${effPct}  PYV ${d.oldDpv}→${d.newDpv} (${dpvDelta})`,
      );
    }
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
