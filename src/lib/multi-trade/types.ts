// Types for the multi-team trade analyzer.
//
// The input is a structured trade definition: which teams are involved
// and what each team is sending to whom. The pricing layer turns it into
// a deterministic per-team verdict using the same PYV/Market blend the
// trade finder uses.
//
// Two-team trades are a degenerate case of N-team: when only two teams
// participate, every "send" lands on the other team automatically and
// the destination dropdown can be hidden. Three or more requires explicit
// destinations because a single asset can go to one of several partners.

import type { Position, SellWindow } from "@/lib/dpv/sellWindow";

export type AssetKind = "player" | "pick";

export type TradeAssetInput = {
  /**
   * Stable id. For players this is the Sleeper player_id. For picks it's
   * the synthetic pick id used elsewhere in the app
   * (`pick:LEAGUE:SEASON:RX:fromROSTER`).
   */
  assetId: string;
  /** Which team currently owns this asset (the source side of the move). */
  fromRosterId: number;
  /** Where this asset is going. Required for 3+ team trades. */
  toRosterId: number;
};

export type TradeTeamInput = {
  rosterId: number;
};

export type AnalyzeTradeInput = {
  leagueId: string;
  /** All teams participating. At least 2, at most 6. */
  teams: TradeTeamInput[];
  /** Every asset movement. Each entry is "asset X goes from team A to team B". */
  movements: TradeAssetInput[];
};

// ---- Output shape ---------------------------------------------------------

export type PricedAsset = {
  assetId: string;
  kind: AssetKind;
  name: string;
  position: string; // "QB"/"RB"/"WR"/"TE"/"PICK"
  team: string | null;
  age: number | null;
  yearsPro: number;
  pyv: number;
  /** Market value scaled into DPV space (mkt * k). Null when no market. */
  scaledMarket: number | null;
  /** Final blended value used in totals. */
  blended: number;
  /** Weight used in the blend; 0 for picks (DPV-scale already). */
  weight: number;
  /** Sell-window verdict — only present for players, not picks. */
  sellWindow: SellWindow | null;
  /** Where this asset moved from / to. */
  fromRosterId: number;
  toRosterId: number;
};

export type TeamSummary = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  receive: PricedAsset[];
  send: PricedAsset[];
  /** Sum of blended value of received assets. */
  receiveTotal: number;
  /** Sum of blended value of sent assets. */
  sendTotal: number;
  /** receiveTotal − sendTotal. */
  netBlend: number;
  /** Same on PYV-only and market-only axes. */
  netPyv: number;
  netMarket: number;
  /** |net| / max(receive, send). */
  imbalancePct: number;
  /** Imbalance fails the 15% gate. */
  failsGate: boolean;
  /** Coarse verdict label for UI. */
  verdict: "winner" | "fair" | "loser";
};

export type AnalyzeTradeResult = {
  leagueId: string;
  /** Global mean-anchoring scale used to put market into DPV space. */
  k: number;
  gateThreshold: number;
  teams: TeamSummary[];
  /** Soft warnings — e.g. "young-player guard fired", "missing market data". */
  notes: string[];
  /**
   * Plain-English explanation of the trade for casual users. Generated
   * by Claude from the deterministic numbers above — never used to
   * change verdicts, only to phrase them. Null when the narrative
   * service is disabled or fails (UI falls back to numbers-only).
   */
  narrative: TradeNarrative | null;
};

export type TradeNarrative = {
  /** 2–4 sentence summary of the deal as a whole. */
  overall: string;
  /** Per-team take. Same rosterId as TeamSummary; 1–2 sentences each. */
  teams: NarrativeTeamTake[];
};

export type NarrativeTeamTake = {
  rosterId: number;
  /** Plain-English explanation of why this side wins / loses / is fair. */
  summary: string;
};

// Helper input bundle for the pricing function — pre-loaded data so the
// pure compute can run synchronously without DB roundtrips.
export type PricingContext = {
  k: number;
  /** All assets (players + picks) the league exposes, indexed by id. */
  assetsById: Map<string, AssetSnapshot>;
  /** Roster labels for nice UI strings. */
  rostersById: Map<number, RosterLabel>;
};

export type AssetSnapshot = {
  assetId: string;
  kind: AssetKind;
  name: string;
  position: string;
  team: string | null;
  age: number | null;
  yearsPro: number;
  pyv: number;
  /** Raw market value (FantasyCalc scale). Null if no market data. */
  marketRaw: number | null;
  /** Per-position rank delta (market − DPV). Null if no market. */
  marketDelta: number | null;
};

export type RosterLabel = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  /** Stable display string preferring teamName, then ownerName. */
  label: string;
};

// Re-export types we surface in the result for convenience.
export type { Position, SellWindow };
