// Pure pricing logic for the multi-team trade analyzer.
//
// Input: a structured trade definition (which teams, which assets move
// where) plus a pre-loaded PricingContext (DPV + market + scale factor).
// Output: per-team summaries with totals, gate status, and per-asset
// sell-window verdicts.
//
// The math mirrors the trade-finder blend — same weights, same global k,
// same 15% imbalance threshold — so a deal that would be surfaced /
// dropped by the finder produces a matching verdict here.

import { computeSellWindow, type Position } from "@/lib/dpv/sellWindow";
import type {
  AnalyzeTradeInput,
  AnalyzeTradeResult,
  AssetSnapshot,
  PricedAsset,
  PricingContext,
  TeamSummary,
} from "./types";

// Same year-aware blend the trade finder uses. Rookies skew most toward
// market because PYV is conservative on thin evidence; vets skew most
// toward PYV because the market discounts production at the back end of
// careers.
function blendWeight(yearsPro: number): number {
  if (yearsPro <= 0) return 0.6;
  if (yearsPro === 1) return 0.5;
  if (yearsPro === 2) return 0.45;
  return 0.4;
}

const GATE_THRESHOLD = 0.15;

function isFantasyPosition(p: string): p is Position {
  return p === "QB" || p === "RB" || p === "WR" || p === "TE";
}

function priceAsset(
  snap: AssetSnapshot,
  k: number,
  fromRosterId: number,
  toRosterId: number,
): PricedAsset {
  // Picks are already on the DPV scale (BASELINE_1_01_DPV = 6000) and we
  // assume market broadly agrees with our pick model — so no scaling and
  // no blend.
  if (snap.kind === "pick") {
    return {
      assetId: snap.assetId,
      kind: "pick",
      name: snap.name,
      position: snap.position,
      team: snap.team,
      age: null,
      yearsPro: 0,
      pyv: snap.pyv,
      scaledMarket: snap.pyv, // by construction picks contribute equally
      blended: snap.pyv,
      weight: 0,
      sellWindow: null,
      fromRosterId,
      toRosterId,
    };
  }

  const scaledMarket = snap.marketRaw !== null ? snap.marketRaw * k : null;
  const w = blendWeight(snap.yearsPro);
  const blended =
    scaledMarket !== null
      ? Math.round(snap.pyv * (1 - w) + scaledMarket * w)
      : snap.pyv;

  // Sell-window only fires for fantasy positions — DST/K aren't tracked
  // and would just produce HOLD-by-default noise.
  const sellWindow = isFantasyPosition(snap.position)
    ? computeSellWindow({
        position: snap.position,
        age: snap.age,
        dpv: snap.pyv,
        marketDelta: snap.marketDelta,
      })
    : null;

  return {
    assetId: snap.assetId,
    kind: "player",
    name: snap.name,
    position: snap.position,
    team: snap.team,
    age: snap.age,
    yearsPro: snap.yearsPro,
    pyv: snap.pyv,
    scaledMarket,
    blended,
    weight: w,
    sellWindow,
    fromRosterId,
    toRosterId,
  };
}

export function priceTrade(
  input: AnalyzeTradeInput,
  ctx: PricingContext,
): AnalyzeTradeResult {
  const notes: string[] = [];

  // Resolve every movement into a PricedAsset. Skip movements whose
  // asset id is missing from the context — we surface a note instead of
  // silently zeroing them, since that would distort totals.
  const priced: PricedAsset[] = [];
  for (const m of input.movements) {
    const snap = ctx.assetsById.get(m.assetId);
    if (!snap) {
      notes.push(`Asset not found: ${m.assetId}`);
      continue;
    }
    priced.push(priceAsset(snap, ctx.k, m.fromRosterId, m.toRosterId));
  }

  // One TeamSummary per participating team, even if a team only sends or
  // only receives. Empty side just shows zero.
  const teams: TeamSummary[] = input.teams.map((t) => {
    const label = ctx.rostersById.get(t.rosterId);
    const receive = priced.filter((p) => p.toRosterId === t.rosterId);
    const send = priced.filter((p) => p.fromRosterId === t.rosterId);

    const receiveTotal = receive.reduce((a, p) => a + p.blended, 0);
    const sendTotal = send.reduce((a, p) => a + p.blended, 0);
    const netBlend = receiveTotal - sendTotal;

    const receivePyv = receive.reduce((a, p) => a + p.pyv, 0);
    const sendPyv = send.reduce((a, p) => a + p.pyv, 0);
    const netPyv = receivePyv - sendPyv;

    const receiveMkt = receive.reduce(
      (a, p) => a + (p.scaledMarket ?? p.pyv),
      0,
    );
    const sendMkt = send.reduce(
      (a, p) => a + (p.scaledMarket ?? p.pyv),
      0,
    );
    const netMarket = receiveMkt - sendMkt;

    const denom = Math.max(receiveTotal, sendTotal);
    const imbalancePct = denom > 0 ? Math.abs(netBlend) / denom : 0;
    const failsGate = imbalancePct > GATE_THRESHOLD;

    // Verdict tone is intentionally tri-state — "winner" / "fair" /
    // "loser". The 15% gate is the boundary between fair and not; an
    // additional 25% threshold separates plain winners/losers from clear
    // fleecings, which is the bucket the AI narrative will lean on.
    let verdict: TeamSummary["verdict"];
    if (imbalancePct <= GATE_THRESHOLD) verdict = "fair";
    else if (netBlend > 0) verdict = "winner";
    else verdict = "loser";

    return {
      rosterId: t.rosterId,
      ownerName: label?.ownerName ?? `Team ${t.rosterId}`,
      teamName: label?.teamName ?? null,
      receive,
      send,
      receiveTotal,
      sendTotal,
      netBlend,
      netPyv,
      netMarket,
      imbalancePct,
      failsGate,
      verdict,
    };
  });

  // Surface a note for any young-player guard that fired so the UI can
  // show context without re-running the sell-window logic.
  for (const p of priced) {
    if (p.sellWindow && p.sellWindow.reason.startsWith("Young (")) {
      notes.push(
        `${p.name}: young-player guard — ${p.sellWindow.reason}`,
      );
    }
  }

  return {
    leagueId: input.leagueId,
    k: ctx.k,
    gateThreshold: GATE_THRESHOLD,
    teams,
    notes,
  };
}
