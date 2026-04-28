// Roster Report Card — composite team-health math.
//
// Five sub-scores, each normalized 0-100 within the league (z-score →
// percentile). Weighted into a single Composite 0-100 with a verdict
// label. Output drives the /league/[id]/team/[rosterId]/report page
// and the per-row summary on /league/[id].
//
// Why league-relative? Decisions happen *in your league* — a 70 here
// means "above league median" which is exactly what you want when
// you're deciding whether to buy or sell. A global benchmark would be
// shareable but less actionable.

import { pickDpv, currentPickWindow } from "@/lib/picks/constants";
import {
  perTeamStarterDemand,
  type ReplacementByPosition,
} from "@/lib/dpv/scarcity";
import { AGE_CLIFFS, type Position } from "@/lib/dpv/constants-aging";

export type { Position };

export type ReportPlayer = {
  playerId: string;
  name: string;
  position: Position;
  birthdate: string | null;
  dpv: number;
};

export type LeaguePick = {
  season: number;
  round: number;
  ownerRosterId: number;
};

export type RosterInput = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  /** Player rows — only positions QB/RB/WR/TE survive into the report. */
  players: ReportPlayer[];
  /** Picks the team owns *now* (after trades). */
  picks: LeaguePick[];
};

export type LeagueInput = {
  /** Sleeper-style roster_positions. Null falls back to 1QB/2RB/3WR/1TE/1FLEX. */
  rosterPositions: readonly string[] | null;
  /** Used when rosterPositions is null — affects nothing else. */
  totalRosters: number | null;
};

// ---- Weights ----------------------------------------------------------------
//
// Production drives raw points. Window separates "sell now" from "hold."
// Age is the construction signal — a young roster scores well on Age
// even when Production is mediocre, which is correct (rebuilds in
// progress should look like rebuilds in progress). Depth and Caps are
// tie-breakers.
const WEIGHTS = {
  production: 0.30,
  window: 0.25,
  age: 0.20,
  depth: 0.15,
  cap: 0.10,
} as const;

// ---- Bench weight -----------------------------------------------------------
//
// Bench players get partial credit (depth has option value but doesn't
// score points). Set to 0 to make Production strict-starter only —
// 0.25 is a compromise that rewards stash-and-trade depth without
// drowning the score in waiver-wire churn.
const BENCH_WEIGHT = 0.25;

// Position-specific aging curves come from `lib/dpv/constants-aging.ts`
// — shared with the sell-window indicator so both features stay in
// lockstep. yearsRemaining(age, pos) returns a 0..2 scalar: how much
// value projects to hold across the next two seasons.

function yearsRemaining(age: number | null, pos: Position): number {
  if (age === null || !Number.isFinite(age)) return 1.5; // neutral
  const c = AGE_CLIFFS[pos];
  // Two-year horizon: each year-end check returns 1.0 if still in the
  // full-value zone, falls linearly through the cliff window, hits 0
  // at "gone." Sum of the two yearly values = 0..2 scalar.
  const yearValue = (a: number): number => {
    if (a < c.full) return 1;
    if (a >= c.gone) return 0;
    if (a >= c.cliff) {
      // Linear taper from cliff to gone.
      return Math.max(0, (c.gone - a) / (c.gone - c.cliff)) * 0.5;
    }
    // Linear taper from full to cliff (still > 0.5).
    return 0.5 + Math.max(0, (c.cliff - a) / (c.cliff - c.full)) * 0.5;
  };
  return yearValue(age) + yearValue(age + 1);
}

function ageFromBirthdate(bd: string | null, asOf: Date = new Date()): number | null {
  if (!bd) return null;
  const ms = asOf.getTime() - new Date(bd).getTime();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms / (365.25 * 24 * 3600 * 1000);
}

// ---- Starter selection -----------------------------------------------------
//
// Walk the roster_positions array and pick the highest-DPV eligible
// player for each slot. FLEX/SUPER_FLEX/REC_FLEX get filled after the
// dedicated slots so a star RB doesn't get burned on a flex when an
// elite backup exists.
const FLEX_ELIGIBLE: Record<string, Position[]> = {
  FLEX: ["RB", "WR", "TE"],
  WR_RB_TE: ["RB", "WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  QB_WR_RB_TE: ["QB", "RB", "WR", "TE"],
  REC_FLEX: ["WR", "TE"],
  WR_TE: ["WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  WR_RB: ["RB", "WR"],
};

const DEFAULT_ROSTER_POSITIONS: readonly string[] = [
  "QB", "RB", "RB", "WR", "WR", "WR", "TE", "FLEX",
  "BN", "BN", "BN", "BN", "BN", "BN",
];

type PickedPlayer = ReportPlayer & { weight: number; isStarter: boolean };

function pickStarters(
  players: ReportPlayer[],
  rosterPositions: readonly string[],
): PickedPlayer[] {
  // Sort once; we'll greedily take the best-eligible for each slot.
  const sorted = [...players].sort((a, b) => b.dpv - a.dpv);
  const used = new Set<string>();
  const picked: PickedPlayer[] = [];

  // Pass 1: dedicated single-position slots (QB/RB/WR/TE first, in array order).
  for (const slot of rosterPositions) {
    const s = slot.toUpperCase();
    if (s === "QB" || s === "RB" || s === "WR" || s === "TE") {
      const next = sorted.find((p) => p.position === s && !used.has(p.playerId));
      if (next) {
        used.add(next.playerId);
        picked.push({ ...next, weight: 1, isStarter: true });
      }
    }
  }
  // Pass 2: flex slots, after dedicated ones are filled. Order doesn't
  // really matter since we always take best-eligible-remaining.
  for (const slot of rosterPositions) {
    const s = slot.toUpperCase();
    const eligible = FLEX_ELIGIBLE[s];
    if (!eligible) continue;
    const next = sorted.find(
      (p) =>
        eligible.includes(p.position) && !used.has(p.playerId),
    );
    if (next) {
      used.add(next.playerId);
      picked.push({ ...next, weight: 1, isStarter: true });
    }
  }
  // Bench: everyone left, partial weight.
  for (const p of sorted) {
    if (used.has(p.playerId)) continue;
    picked.push({ ...p, weight: BENCH_WEIGHT, isStarter: false });
  }
  return picked;
}

// ---- Pick valuation --------------------------------------------------------
//
// Cap Health uses round-average DPV with year discount. Year+1 is full
// value, Year+2 is 70% (uncertainty), Year+3+ is 50%. Matches the
// trade calculator's pick math but adds the temporal discount the trade
// calc doesn't need (trades are present-tense).
function pickValue(season: number, round: number, now: Date = new Date()): number {
  if (round < 1 || round > 3) return 0;
  const r = round as 1 | 2 | 3;
  const [y0] = currentPickWindow(now);
  const yearOffset = season - y0;
  if (yearOffset < 0) return 0;
  const discount = yearOffset === 0 ? 1.0 : yearOffset === 1 ? 0.7 : 0.5;
  // Average across 12 slots — same shape generateTeamRoundPicks uses,
  // since we only know round granularity from Sleeper.
  let sum = 0;
  let n = 0;
  for (let slot = 1; slot <= 12; slot++) {
    const v = pickDpv(season, r, slot, y0);
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? Math.round((sum / n) * discount) : 0;
}

// ---- Per-roster raw stats --------------------------------------------------

type RawStats = {
  rosterId: number;
  // Production: weighted-DPV total.
  production: number;
  // Window: weighted-DPV × yearsRemaining.
  window: number;
  // Average starter age (weighted by starter slot, not bench).
  avgStarterAge: number;
  // Avg drop% if your starter at each slot got hurt (lower is better).
  depthDrop: number;
  // Sum of pick values (with year discount).
  cap: number;
};

function computeRaw(
  roster: RosterInput,
  rosterPositions: readonly string[],
  positionDemand: ReplacementByPosition,
): RawStats {
  const picked = pickStarters(roster.players, rosterPositions);
  const starters = picked.filter((p) => p.isStarter);
  const bench = picked.filter((p) => !p.isStarter);

  // Production
  let production = 0;
  for (const p of starters) production += p.dpv * p.weight;
  for (const p of bench) production += p.dpv * p.weight;

  // Window — uses age decay
  let windowTotal = 0;
  for (const p of starters) {
    const age = ageFromBirthdate(p.birthdate);
    windowTotal += p.dpv * p.weight * (yearsRemaining(age, p.position) / 2);
  }
  for (const p of bench) {
    const age = ageFromBirthdate(p.birthdate);
    windowTotal += p.dpv * p.weight * (yearsRemaining(age, p.position) / 2);
  }

  // Avg starter age
  let ageSum = 0;
  let ageWeight = 0;
  for (const p of starters) {
    const age = ageFromBirthdate(p.birthdate);
    if (age === null) continue;
    ageSum += age * p.weight;
    ageWeight += p.weight;
  }
  const avgStarterAge = ageWeight > 0 ? ageSum / ageWeight : 27;

  // Depth — for each starter, drop = (starter - best_eligible_backup) / starter
  let totalDrop = 0;
  let dropCount = 0;
  for (const p of starters) {
    // Best non-starter at the same position. Falls back to "everyone
    // else got hurt too" → no backup → 100% drop.
    const backup = bench
      .filter((b) => b.position === p.position)
      .sort((a, b) => b.dpv - a.dpv)[0];
    const backupDpv = backup?.dpv ?? 0;
    if (p.dpv <= 0) continue;
    const drop = Math.max(0, (p.dpv - backupDpv) / p.dpv);
    totalDrop += drop;
    dropCount++;
  }
  const depthDrop = dropCount > 0 ? totalDrop / dropCount : 1;

  // Cap (pick capital)
  let cap = 0;
  for (const pk of roster.picks) cap += pickValue(pk.season, pk.round);

  // Suppress unused-warning — positionDemand might be useful later for
  // per-position normalization.
  void positionDemand;

  return {
    rosterId: roster.rosterId,
    production,
    window: windowTotal,
    avgStarterAge,
    depthDrop,
    cap,
  };
}

// ---- League-relative normalization ----------------------------------------
//
// Convert raw → 0-100 via percentile rank within the league. Ties take
// the average rank (standard competition ranking would penalize ties).
function percentileRank(values: number[], target: number): number {
  if (values.length === 0) return 50;
  let below = 0;
  let equal = 0;
  for (const v of values) {
    if (v < target) below++;
    else if (v === target) equal++;
  }
  // (below + 0.5*equal) / n keeps ties at the midpoint.
  return Math.round(((below + 0.5 * equal) / values.length) * 100);
}

// Age has a non-linear "ideal" curve (peak 24-28). We score raw avg age
// against an idealization first, then percentile-rank the resulting
// scores within the league. That way a league of all 30+ teams still
// produces a spread instead of everyone scoring zero.
function ageIdealScore(avgAge: number): number {
  if (avgAge < 22) return 65;
  if (avgAge < 24) return interp(avgAge, 22, 24, 65, 80);
  if (avgAge < 26) return interp(avgAge, 24, 26, 80, 100);
  if (avgAge < 28) return interp(avgAge, 26, 28, 100, 90);
  if (avgAge < 30) return interp(avgAge, 28, 30, 90, 70);
  if (avgAge < 32) return interp(avgAge, 30, 32, 70, 45);
  return Math.max(25, 45 - (avgAge - 32) * 5);
}

function interp(x: number, x0: number, x1: number, y0: number, y1: number): number {
  if (x1 === x0) return y0;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

// ---- Verdict thresholds ----------------------------------------------------
//
// Calibrated so a normal league has roughly: 1-2 contenders, 3-4
// playoff cores, ~half bubble, 2-3 rebuilders. Tweak if it feels off.
const VERDICTS = [
  { min: 80, label: "Win-now contender", tone: "elite" as const },
  { min: 65, label: "Playoff core", tone: "good" as const },
  { min: 50, label: "Bubble", tone: "neutral" as const },
  { min: 35, label: "Soft rebuild", tone: "warn" as const },
  { min: 0, label: "Full rebuild", tone: "bad" as const },
];

export type VerdictTone = "elite" | "good" | "neutral" | "warn" | "bad";

export type SubScore = {
  score: number; // 0-100
  raw: number;
  reason: string;
};

export type ReportCard = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  composite: number; // 0-100
  verdict: string;
  tone: VerdictTone;
  subScores: {
    production: SubScore;
    window: SubScore;
    age: SubScore;
    depth: SubScore;
    cap: SubScore;
  };
  // Top 3 actions, ordered by impact.
  actions: string[];
};

// ---- Reason templates ------------------------------------------------------
//
// Each sub-score gets a short reason string at the appropriate quintile.
// Templates pull league-relative context (e.g. "X% above median") so the
// report card feels personalized instead of generic.
function reasonFor(
  metric: "production" | "window" | "age" | "depth" | "cap",
  score: number,
  ctx: { avgAge?: number; depthDrop?: number; topAgingPlayer?: string | null },
): string {
  const tier = score >= 75 ? "high" : score >= 50 ? "mid" : score >= 25 ? "low" : "vlow";

  if (metric === "production") {
    if (tier === "high") return "Elite starting lineup — top of the league.";
    if (tier === "mid") return "Starters are roughly average. Other scores will decide your season.";
    if (tier === "low") return "Lineup underperforms — your floor is the league's biggest problem to solve.";
    return "Bottom-tier production. Aggressive moves needed even to make playoffs.";
  }

  if (metric === "window") {
    if (tier === "high") return "Most of your value projects to hold next year — full send.";
    if (tier === "mid") return "Window is solid but not elite. A 2-year contention plan still makes sense.";
    if (tier === "low") {
      const tag = ctx.topAgingPlayer ? ` (starting with ${ctx.topAgingPlayer})` : "";
      return `Window is closing — sell aging assets for picks${tag}.`;
    }
    return "Roster is built around fading assets. Rebuild posture is correct.";
  }

  if (metric === "age") {
    const a = ctx.avgAge !== undefined ? ` (avg starter ${ctx.avgAge.toFixed(1)})` : "";
    if (tier === "high") return `Construction is well-shaped${a} — peak window with runway.`;
    if (tier === "mid") return `Mixed age profile${a}. Watch for drop-off in 1-2 years.`;
    if (tier === "low") return `Old skewed${a}. Trade vets for younger production while value holds.`;
    return `Roster is past its window${a}. Full reset.`;
  }

  if (metric === "depth") {
    const pct = ctx.depthDrop !== undefined ? ` (avg ${Math.round(ctx.depthDrop * 100)}% loss to injury)` : "";
    if (tier === "high") return `Strong bench${pct} — you can absorb a key injury.`;
    if (tier === "mid") return `Depth is OK${pct} — one bad injury hurts but isn't terminal.`;
    if (tier === "low") return `Thin bench${pct} — an injury at a key spot tanks your week.`;
    return `Almost no real backups${pct}. One injury could end your season.`;
  }

  // cap
  if (tier === "high") return "Pick capital is well above average — you can rebuild quickly if needed.";
  if (tier === "mid") return "Pick bank is roughly average.";
  if (tier === "low") return "Below-average pick capital — protect what you have.";
  return "Almost no future picks. Rebuilding will be slow.";
}

// ---- Action generator ------------------------------------------------------
//
// Picks the 2 lowest non-Production sub-scores and templates an action
// per low score. Adds a "high-composite" capstone if the team is a
// contender.
function generateActions(
  card: Omit<ReportCard, "actions">,
  ctx: { weakestStartingPos: Position | null; topAgingStarter: string | null },
): string[] {
  const actions: string[] = [];
  const ranked = [
    { key: "window" as const, score: card.subScores.window.score },
    { key: "age" as const, score: card.subScores.age.score },
    { key: "depth" as const, score: card.subScores.depth.score },
    { key: "cap" as const, score: card.subScores.cap.score },
  ].sort((a, b) => a.score - b.score);

  for (const r of ranked.slice(0, 2)) {
    if (r.key === "window") {
      const who = ctx.topAgingStarter ? ` Start with ${ctx.topAgingStarter}.` : "";
      actions.push(`Sell aging starters for picks while value holds.${who}`);
    } else if (r.key === "age") {
      const pos = ctx.weakestStartingPos ?? "your weakest spot";
      actions.push(`Target younger production at ${pos} (24-26yo starters).`);
    } else if (r.key === "depth") {
      actions.push("Add depth — even waiver pickups raise your floor.");
    } else if (r.key === "cap") {
      actions.push("Stop renting vets. Protect Year+1 and Year+2 picks.");
    }
  }

  // Contender capstone — replace generic actions if we're elite.
  if (card.composite >= 80) {
    const pos = ctx.weakestStartingPos ?? "your weakest position";
    return [
      `You're a contender. Spend picks to plug ${pos}.`,
      ...actions.slice(0, 2),
    ];
  }
  return actions;
}

// ---- Main entry point ------------------------------------------------------

export function computeReportCards(
  rosters: RosterInput[],
  league: LeagueInput,
): ReportCard[] {
  const rosterPositions =
    league.rosterPositions && league.rosterPositions.length > 0
      ? league.rosterPositions
      : DEFAULT_ROSTER_POSITIONS;
  const positionDemand = perTeamStarterDemand(rosterPositions);

  // Pass 1: raw stats per roster.
  const raws = rosters.map((r) => computeRaw(r, rosterPositions, positionDemand));

  // Pass 2: league-relative normalization.
  const productions = raws.map((r) => r.production);
  const windows = raws.map((r) => r.window);
  const ageScores = raws.map((r) => ageIdealScore(r.avgStarterAge));
  // Depth: lower drop is better, so invert (1 - drop) for percentile.
  const depthInverse = raws.map((r) => 1 - r.depthDrop);
  const caps = raws.map((r) => r.cap);

  return raws.map((raw, i) => {
    const roster = rosters[i];
    const productionScore = percentileRank(productions, raw.production);
    const windowScore = percentileRank(windows, raw.window);
    const ageScore = percentileRank(ageScores, ageScores[i]);
    const depthScore = percentileRank(depthInverse, depthInverse[i]);
    const capScore = percentileRank(caps, raw.cap);

    const composite = Math.round(
      productionScore * WEIGHTS.production +
        windowScore * WEIGHTS.window +
        ageScore * WEIGHTS.age +
        depthScore * WEIGHTS.depth +
        capScore * WEIGHTS.cap,
    );

    const verdict =
      VERDICTS.find((v) => composite >= v.min) ?? VERDICTS[VERDICTS.length - 1];

    // Context for reason strings + actions.
    const picked = pickStarters(roster.players, rosterPositions);
    const starters = picked.filter((p) => p.isStarter);
    const topAging = [...starters]
      .map((p) => ({
        p,
        age: ageFromBirthdate(p.birthdate),
      }))
      .filter((x) => x.age !== null && x.age >= AGE_CLIFFS[x.p.position].full)
      .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))[0];

    // Weakest starting position by total starter DPV at that position.
    const startersByPos: Record<Position, number> = { QB: 0, RB: 0, WR: 0, TE: 0 };
    for (const p of starters) startersByPos[p.position] += p.dpv;
    let weakest: Position | null = null;
    let weakestVal = Infinity;
    for (const pos of ["QB", "RB", "WR", "TE"] as const) {
      // Only consider positions the league actually starts.
      if (positionDemand[pos] <= 0) continue;
      if (startersByPos[pos] < weakestVal) {
        weakestVal = startersByPos[pos];
        weakest = pos;
      }
    }

    const card: Omit<ReportCard, "actions"> = {
      rosterId: roster.rosterId,
      ownerName: roster.ownerName,
      teamName: roster.teamName,
      composite,
      verdict: verdict.label,
      tone: verdict.tone,
      subScores: {
        production: {
          score: productionScore,
          raw: Math.round(raw.production),
          reason: reasonFor("production", productionScore, {}),
        },
        window: {
          score: windowScore,
          raw: Math.round(raw.window),
          reason: reasonFor("window", windowScore, {
            topAgingPlayer: topAging?.p.name ?? null,
          }),
        },
        age: {
          score: ageScore,
          raw: Number(raw.avgStarterAge.toFixed(1)),
          reason: reasonFor("age", ageScore, { avgAge: raw.avgStarterAge }),
        },
        depth: {
          score: depthScore,
          raw: Number(raw.depthDrop.toFixed(2)),
          reason: reasonFor("depth", depthScore, { depthDrop: raw.depthDrop }),
        },
        cap: {
          score: capScore,
          raw: Math.round(raw.cap),
          reason: reasonFor("cap", capScore, {}),
        },
      },
    };

    return {
      ...card,
      actions: generateActions(card, {
        weakestStartingPos: weakest,
        topAgingStarter: topAging?.p.name ?? null,
      }),
    };
  });
}
