// Deterministic attribution for week-over-week PYV moves.
//
// Given two DPVBreakdown snapshots, compute which sub-scores moved
// most and emit short plain-English bullets explaining the delta. No
// LLM involved — the model already knows which input changed; we just
// need to phrase it.
//
// Why deterministic: the breakdown sub-scores are first-class fields
// (opportunityScore, ageModifier, etc.). Mapping each to a label and a
// magnitude is a 100-line module, runs server-side with zero latency
// or cost, and is fully testable. An LLM would add latency, cost, and
// hallucination risk for a problem that doesn't need it.
//
// What we don't claim:
//   - Causation. The note says "opportunity score moved from 0.42 to
//     0.61" not "because Mixon got hurt." We don't know why.
//   - Significance vs. noise. Sub-scores can drift slightly between
//     daily computes from underlying data refreshes. We threshold on a
//     minimum movement (configurable per field) so noise is filtered.
//   - Rookies. The rookie prior has a different breakdown shape and
//     evolves day-to-day for different reasons (combine data landing,
//     draft capital changing). We return null for rookie comparisons
//     so the UI shows "PYV moved" without noise. Phase 2 can extend.

import type { DPVBreakdown } from "./types";

export type WhatChangedNote = {
  /** Headline like "Opportunity climbed". Used as a bullet label. */
  headline: string;
  /** Plain-language detail like "0.42 → 0.61 (+45%)". */
  detail: string;
  /** Direction the change pushed PYV — used to color the bullet. */
  direction: "up" | "down" | "neutral";
};

export type WhatChanged = {
  /** Total PYV move in absolute points and %, signed. */
  net: { absolute: number; pct: number };
  /** Span of the comparison in days. */
  spanDays: number;
  /** Up to 3 bullets, ranked by impact magnitude. May be empty if
   *  PYV barely moved or all sub-score moves are sub-threshold. */
  notes: WhatChangedNote[];
  /** True when one or both endpoints have no breakdown — only the
   *  net delta is meaningful, no per-sub-score attribution. */
  attributionUnavailable: boolean;
};

// Per-field minimum delta below which we suppress the note as noise.
// Tuned conservatively: a 0.02 swing on opportunityScore is usually a
// data refresh artifact; a 0.05 swing is a real volume change.
const FIELD_THRESHOLDS: Record<string, number> = {
  opportunityScore: 0.05,
  ageModifier: 0.02,
  olineModifier: 0.02,
  qbQualityModifier: 0.02,
  bbcsModifier: 0.02,
  scarcityMultiplier: 0.02,
  rookieDisplacementMult: 0.02,
  qbStarterRateMult: 0.05,
  qbDepthChartMult: 0.05,
  bps: 0.3, // PPG — half a point per game is meaningful
};

// Pretty headlines per breakdown field. The "direction" map below
// decides which arrow we attach.
const FIELD_LABELS: Record<string, string> = {
  bps: "Recent production",
  opportunityScore: "Opportunity",
  ageModifier: "Age curve",
  olineModifier: "O-line context",
  qbQualityModifier: "QB play",
  bbcsModifier: "Consistency",
  scarcityMultiplier: "Position scarcity",
  rookieDisplacementMult: "Incoming rookies",
  qbStarterRateMult: "Starter confidence",
  qbDepthChartMult: "Depth chart",
};

// Whether an increase in this field pushes PYV up (true) or down
// (false). Most multipliers are "more is better" — exceptions are the
// rookieDisplacementMult and qbDepthChartMult which are inverse.
const FIELD_DIRECTION: Record<string, "positive" | "negative"> = {
  bps: "positive",
  opportunityScore: "positive",
  ageModifier: "positive",
  olineModifier: "positive",
  qbQualityModifier: "positive",
  bbcsModifier: "positive",
  scarcityMultiplier: "positive",
  rookieDisplacementMult: "negative", // higher = more competition = bad
  qbStarterRateMult: "positive",
  qbDepthChartMult: "positive",
};

/** Format a delta for the detail text. We pick precision based on
 *  scale — multipliers ~1.0 want 2 decimals, opportunity 0-1 wants 2,
 *  bps wants 1. */
function fmtValue(field: string, v: number): string {
  if (field === "bps") return v.toFixed(1);
  return v.toFixed(2);
}

function pctChange(from: number, to: number): number {
  if (from === 0) return to === 0 ? 0 : 100;
  return ((to - from) / from) * 100;
}

function daysBetween(a: string, b: string): number {
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / (1000 * 60 * 60 * 24));
}

/**
 * Compare two snapshots and return the most informative bullets.
 *
 * @param older  Earlier snapshot. dpv + (optional) breakdown.
 * @param newer  Later snapshot. dpv + (optional) breakdown.
 */
export function compareBreakdowns(args: {
  older: { date: string; dpv: number; breakdown: DPVBreakdown | null };
  newer: { date: string; dpv: number; breakdown: DPVBreakdown | null };
}): WhatChanged {
  const { older, newer } = args;

  const net = {
    absolute: newer.dpv - older.dpv,
    pct: Number(pctChange(older.dpv, newer.dpv).toFixed(1)),
  };
  const spanDays = daysBetween(older.date, newer.date);

  // No breakdown on either endpoint — return just the net.
  if (!older.breakdown || !newer.breakdown) {
    return {
      net,
      spanDays,
      notes: [],
      attributionUnavailable: true,
    };
  }

  // Score each tracked field by absolute delta × directional sign.
  // Then take the top 3 that pass the noise threshold.
  type Scored = {
    field: string;
    fromVal: number;
    toVal: number;
    delta: number;
    dpvImpact: "up" | "down";
  };
  const scored: Scored[] = [];

  for (const field of Object.keys(FIELD_LABELS)) {
    const fromVal = (older.breakdown as unknown as Record<string, unknown>)[
      field
    ];
    const toVal = (newer.breakdown as unknown as Record<string, unknown>)[
      field
    ];
    if (typeof fromVal !== "number" || typeof toVal !== "number") continue;
    const delta = toVal - fromVal;
    if (Math.abs(delta) < (FIELD_THRESHOLDS[field] ?? 0.02)) continue;

    // Direction: a "positive-direction" field that increased pushes
    // PYV up; a negative-direction field that increased pushes it
    // down (e.g., more rookie competition).
    const fieldDir = FIELD_DIRECTION[field] ?? "positive";
    const dpvImpact: "up" | "down" =
      (delta > 0) === (fieldDir === "positive") ? "up" : "down";

    scored.push({ field, fromVal, toVal, delta, dpvImpact });
  }

  // Rank by absolute delta. We could rank by estimated dpv impact (delta
  // × elasticity) but the breakdown JSON doesn't ship elasticities and
  // raw delta is a fine proxy in practice.
  scored.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const top = scored.slice(0, 3);

  const notes: WhatChangedNote[] = top.map((s) => {
    const pct = pctChange(s.fromVal, s.toVal);
    const arrow = s.delta > 0 ? "↑" : "↓";
    const headline = `${FIELD_LABELS[s.field]} ${arrow}`;
    const detail = `${fmtValue(s.field, s.fromVal)} → ${fmtValue(
      s.field,
      s.toVal,
    )} (${pct > 0 ? "+" : ""}${pct.toFixed(0)}%)`;
    return { headline, detail, direction: s.dpvImpact };
  });

  return {
    net,
    spanDays,
    notes,
    attributionUnavailable: false,
  };
}
