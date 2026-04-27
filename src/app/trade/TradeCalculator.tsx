"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ScoringFormat } from "@/lib/dpv/types";
import type { ReplacementByPosition } from "@/lib/dpv/scarcity";

export type TradePlayer = {
  id: string;
  name: string;
  position: string;
  team: string | null;
  age: number | null;
  dpv: number;
  /**
   * Player's market value in the same scoring format. Falls back to `dpv`
   * when no market data exists (deep depth, picks per sub-option C) so
   * sums on the market axis don't crater. `hasMarket` distinguishes real
   * data from the fallback.
   */
  market: number;
  hasMarket: boolean;
  /**
   * Position-rank delta: marketRank − dpvRank within the (DPV ∩ Market)
   * intersection at the player's position. Positive = DPV ranks higher
   * than market (Buy signal); negative = market ranks higher (Sell). Null
   * when the player isn't in the intersection (no market, or picks).
   */
  marketDelta: number | null;
  tier: string;
};

export type LeagueRosterOption = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
  playerIds: string[];
};

const FORMATS: { key: ScoringFormat; label: string }[] = [
  { key: "STANDARD", label: "Standard" },
  { key: "HALF_PPR", label: "Half PPR" },
  { key: "FULL_PPR", label: "Full PPR" },
];

// Replacement DPV is now league-aware — passed down from the server based
// on the selected league's roster_positions (or a 12-team 1-QB default).
// SF leagues raise QB scarcity, deep-flex leagues raise RB/WR scarcity.
// See src/lib/dpv/scarcity.ts for the math.
function valueAboveReplacement(
  p: TradePlayer,
  replacement: ReplacementByPosition,
): number {
  const repl =
    p.position === "QB" ||
    p.position === "RB" ||
    p.position === "WR" ||
    p.position === "TE"
      ? replacement[p.position]
      : 0; // PICK / unsupported positions: no replacement floor
  return Math.max(0, p.dpv - repl);
}

// Per-player buy/sell flag from rank delta. A 5-rank gap inside a position
// is enough to be more than noise; below that we treat the player as
// market-aligned and don't show a badge.
function buySellBadge(
  delta: number | null,
): { label: string; tone: "buy" | "sell" } | null {
  if (delta === null) return null;
  if (delta >= 5) return { label: "BUY", tone: "buy" };
  if (delta <= -5) return { label: "SELL", tone: "sell" };
  return null;
}

const BUY_SELL_CLASS: Record<"buy" | "sell", string> = {
  buy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  sell: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

function sideValue(
  side: TradePlayer[],
  replacement: ReplacementByPosition,
): {
  dpv: number;
  market: number;
  var_: number;
  avgAge: number | null;
} {
  const dpv = side.reduce((a, b) => a + b.dpv, 0);
  const market = side.reduce((a, b) => a + b.market, 0);
  const var_ = side.reduce(
    (a, b) => a + valueAboveReplacement(b, replacement),
    0,
  );
  const ages = side.map((p) => p.age).filter((x): x is number => x !== null);
  const avgAge = ages.length
    ? ages.reduce((a, b) => a + b, 0) / ages.length
    : null;
  return { dpv, market, var_, avgAge };
}

type Verdict = {
  label: string;
  flavor: string;
  explanation: string;
  tone: "win_big" | "win" | "fair" | "loss" | "loss_big";
  /** Δ on the production axis (DPV-driven). Positive = you win on DPV. */
  dpvPct: number;
  /** Δ on the price axis (market-driven). Positive = market thinks you won. */
  marketPct: number;
};

// Threshold between "neutral" and "matters" for each axis. Anything inside
// ±10% reads as "rough wash" on that axis; outside it counts as a real lean.
const POS = 0.1;
// Strong move that triggers Steal/Disaster instead of Solid Win/Lean Reject.
const STRONG = 0.2;

function classify(pct: number): "pos" | "neutral" | "neg" {
  if (pct > POS) return "pos";
  if (pct < -POS) return "neg";
  return "neutral";
}

function ageNoteFor(g: ReturnType<typeof sideValue>, r: ReturnType<typeof sideValue>): string {
  const ageDelta =
    g.avgAge !== null && r.avgAge !== null ? r.avgAge - g.avgAge : 0;
  if (Math.abs(ageDelta) < 1.5) return "";
  return ageDelta > 0
    ? ` Your return is ${ageDelta.toFixed(1)} yrs older on average — factor in dynasty shelf life.`
    : ` Your return is ${(-ageDelta).toFixed(1)} yrs younger on average — small long-term boost.`;
}

function verdictFor(
  giving: TradePlayer[],
  getting: TradePlayer[],
  replacement: ReplacementByPosition,
): Verdict | null {
  if (giving.length === 0 || getting.length === 0) return null;
  const g = sideValue(giving, replacement);
  const r = sideValue(getting, replacement);

  // Production axis runs on VAR (value above replacement) instead of raw
  // DPV — that's how league construction enters the math. Two players with
  // identical DPV at different positions can have very different VAR: a
  // 9000-DPV TE in a 1-TE league has way more VAR than a 9000-DPV QB in a
  // 1-QB league because the QB cliff sits at ~7500 while the TE cliff sits
  // at ~3000. Trading the QB for the TE is a real win even though raw DPV
  // looks even.
  //
  // Floor at 1 to keep symmetric percent diff well-defined when both sides
  // are sub-replacement (e.g. picks-only trades).
  const dpvDenom = Math.max(g.var_, r.var_, 1);
  const dpvPct = (r.var_ - g.var_) / dpvDenom;

  const mktDenom = Math.max(g.market, r.market, 1);
  const marketPct = (r.market - g.market) / mktDenom;

  const ageNote = ageNoteFor(g, r);

  // 3×3 verdict matrix — DPV (production) × Market (price). The cells
  // disagree are the *most valuable* ones: Buy-Low and Sell-High flag
  // mispricings, exactly the trades worth making in dynasty.
  const dpvCls = classify(dpvPct);
  const mktCls = classify(marketPct);

  const dpvPctRound = Math.round(dpvPct * 100);
  const mktPctRound = Math.round(marketPct * 100);
  const fmtPct = (n: number) => (n > 0 ? `+${n}%` : `${n}%`);

  // ── Both axes positive: pure win ──────────────────────────────
  if (dpvCls === "pos" && mktCls === "pos") {
    if (dpvPct >= STRONG || marketPct >= STRONG) {
      return {
        label: "Subway King Steal",
        flavor:
          "\"Dang ol' footlong, man, I tell you what.\" Both axes confirm you robbed them.",
        explanation: `Production ${fmtPct(dpvPctRound)} and market ${fmtPct(mktPctRound)} in your favor. Accept before they notice.${ageNote}`,
        tone: "win_big",
        dpvPct,
        marketPct,
      };
    }
    return {
      label: "Solid Win",
      flavor: "Both production and market lean your way.",
      explanation: `DPV ${fmtPct(dpvPctRound)}, market ${fmtPct(mktPctRound)}. Real value gain, fairly priced trade.${ageNote}`,
      tone: "win",
      dpvPct,
      marketPct,
    };
  }

  // ── Production wins, market disagrees: BUY-LOW (the prized signal) ──
  if (dpvCls === "pos" && mktCls === "neg") {
    return {
      label: "Buy-Low Steal",
      flavor:
        "DPV sees real value the market hasn't priced in. Print this trade.",
      explanation: `Model says you gain ${fmtPct(dpvPctRound)} of production, but market would call this ${fmtPct(mktPctRound)} against you — meaning the league at large would view it close to fair, possibly even in their favor. The disagreement IS the alpha.${ageNote}`,
      tone: "win",
      dpvPct,
      marketPct,
    };
  }

  // ── Production wins, market agrees lightly ────────────────────
  if (dpvCls === "pos" && mktCls === "neutral") {
    return {
      label: "Solid Win",
      flavor: "Production gain at a fair-market price.",
      explanation: `DPV ${fmtPct(dpvPctRound)} in your favor; market reads roughly even (${fmtPct(mktPctRound)}). Clean win.${ageNote}`,
      tone: "win",
      dpvPct,
      marketPct,
    };
  }

  // ── Production neutral, market wins: SELL-HIGH ────────────────
  if (dpvCls === "neutral" && mktCls === "pos") {
    return {
      label: "Sell-High",
      flavor:
        "Production unchanged but the market thinks you cleaned them out.",
      explanation: `DPV reads roughly even (${fmtPct(dpvPctRound)}) but you gain ${fmtPct(mktPctRound)} of market value — you're cashing in on hype before it cools. Solid take.${ageNote}`,
      tone: "win",
      dpvPct,
      marketPct,
    };
  }

  // ── Both axes neutral: fair trade ─────────────────────────────
  if (dpvCls === "neutral" && mktCls === "neutral") {
    return {
      label: "Fair Trade",
      flavor: "Roughly balanced on both axes — comes down to roster fit.",
      explanation: `DPV within ${Math.abs(dpvPctRound)}% and market within ${Math.abs(mktPctRound)}%. If this fills a hole or consolidates roster spots, take it.${ageNote}`,
      tone: "fair",
      dpvPct,
      marketPct,
    };
  }

  // ── Production neutral, market dings you: HIDDEN VALUE ────────
  if (dpvCls === "neutral" && mktCls === "neg") {
    return {
      label: "Hidden Value",
      flavor: "DPV stays even but market thinks you lost slightly.",
      explanation: `Production roughly unchanged (${fmtPct(dpvPctRound)}); market trails you ${fmtPct(mktPctRound)}. You see something the league doesn't — defensible if your roster needs the swap.${ageNote}`,
      tone: "fair",
      dpvPct,
      marketPct,
    };
  }

  // ── Production loses, market agrees lightly: lean reject ──────
  if (dpvCls === "neg" && mktCls === "neutral") {
    return {
      label: "Lean Reject",
      flavor: "Production loss without market compensation.",
      explanation: `DPV ${fmtPct(dpvPctRound)} against you, market reads even (${fmtPct(mktPctRound)}). Ask for a throw-in or pass.${ageNote}`,
      tone: "loss",
      dpvPct,
      marketPct,
    };
  }

  // ── Production loses, market wins: CALCULATED SELL-HIGH ───────
  // This is a real cash-out — you take a small production hit in exchange
  // for a big market gain. Defensible if you can replace the lost points
  // off the wire and need the future asset.
  if (dpvCls === "neg" && mktCls === "pos") {
    return {
      label: "Calculated Sell-High",
      flavor:
        "Slight production loss but big market gain. Hype-sell if you can replace the points.",
      explanation: `DPV ${fmtPct(dpvPctRound)} against you; market ${fmtPct(mktPctRound)} in your favor. The league overpays for the brand — only take it if you have a plug-in replacement on the wire or in your league.${ageNote}`,
      tone: "fair",
      dpvPct,
      marketPct,
    };
  }

  // ── Both axes negative: disaster ──────────────────────────────
  if (dpvPct <= -STRONG && marketPct <= -STRONG) {
    return {
      label: "Bobby Hill Trade",
      flavor:
        "\"Son, that dog won't hunt.\" Losing on both axes — pure giveaway.",
      explanation: `Production ${fmtPct(dpvPctRound)} AND market ${fmtPct(mktPctRound)} against you. Walk away and don't look back.${ageNote}`,
      tone: "loss_big",
      dpvPct,
      marketPct,
    };
  }
  return {
    label: "Lean Reject",
    flavor: "Both production and market tilt against you.",
    explanation: `DPV ${fmtPct(dpvPctRound)} and market ${fmtPct(mktPctRound)} against you. Pass.${ageNote}`,
    tone: "loss",
    dpvPct,
    marketPct,
  };
}

export default function TradeCalculator({
  players,
  fmt,
  leagueId,
  rosterOptions,
  defaultFromRosterId,
  replacement,
  replacementContext,
}: {
  players: TradePlayer[];
  fmt: ScoringFormat;
  leagueId: string | null;
  rosterOptions: LeagueRosterOption[];
  defaultFromRosterId: number | null;
  /** League-aware replacement DPV per position. Drives VAR + verdict. */
  replacement: ReplacementByPosition;
  /** Metadata for the scarcity tooltip — explains where the cliff came from. */
  replacementContext: {
    teamCount: number;
    rosterPositions: string[] | null;
    isDefault: boolean;
  };
}) {
  const [giving, setGiving] = useState<TradePlayer[]>([]);
  const [getting, setGetting] = useState<TradePlayer[]>([]);
  const [fromRoster, setFromRoster] = useState<number | null>(
    defaultFromRosterId,
  );
  const [toRoster, setToRoster] = useState<number | null>(null);

  // Sync URL param -> local state if user navigated here with ?from=X.
  useEffect(() => {
    if (defaultFromRosterId !== null) setFromRoster(defaultFromRosterId);
  }, [defaultFromRosterId]);

  const taken = useMemo(
    () => new Set([...giving, ...getting].map((p) => p.id)),
    [giving, getting],
  );

  const fromRosterIds = useMemo(() => {
    if (fromRoster === null) return null;
    const r = rosterOptions.find((x) => x.rosterId === fromRoster);
    return r ? new Set(r.playerIds) : null;
  }, [fromRoster, rosterOptions]);

  const toRosterIds = useMemo(() => {
    if (toRoster === null) return null;
    const r = rosterOptions.find((x) => x.rosterId === toRoster);
    return r ? new Set(r.playerIds) : null;
  }, [toRoster, rosterOptions]);

  const verdict = verdictFor(giving, getting, replacement);
  const g = sideValue(giving, replacement);
  const r = sideValue(getting, replacement);

  const leagueMode = leagueId !== null && rosterOptions.length > 0;

  return (
    <>
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {FORMATS.map((f) => {
            const params = new URLSearchParams();
            params.set("fmt", f.key);
            if (leagueId) params.set("league", leagueId);
            if (defaultFromRosterId !== null)
              params.set("from", String(defaultFromRosterId));
            return (
              <Link
                key={f.key}
                href={`/trade?${params.toString()}`}
                className={`px-3 py-1.5 ${
                  fmt === f.key
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {f.label}
              </Link>
            );
          })}
        </div>
        {leagueMode && (
          <Link
            href={`/league/${leagueId}`}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline"
          >
            ← back to league
          </Link>
        )}
        {(giving.length > 0 || getting.length > 0) && (
          <button
            type="button"
            onClick={() => {
              setGiving([]);
              setGetting([]);
            }}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 px-2 py-1 rounded border border-zinc-200 dark:border-zinc-800"
          >
            Clear both sides
          </button>
        )}
      </div>

      <ScarcityPanel
        replacement={replacement}
        teamCount={replacementContext.teamCount}
        rosterPositions={replacementContext.rosterPositions}
        isDefault={replacementContext.isDefault}
        leagueName={null}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
        <TradeSide
          title="Giving"
          accent="rose"
          players={players}
          taken={taken}
          side={giving}
          setSide={setGiving}
          summary={g}
          leagueMode={leagueMode}
          rosterOptions={rosterOptions}
          selectedRosterId={fromRoster}
          setSelectedRosterId={setFromRoster}
          rosterPlayerIds={fromRosterIds}
          rosterLabel="My team"
        />
        <TradeSide
          title="Getting"
          accent="emerald"
          players={players}
          taken={taken}
          side={getting}
          setSide={setGetting}
          summary={r}
          leagueMode={leagueMode}
          rosterOptions={rosterOptions}
          selectedRosterId={toRoster}
          setSelectedRosterId={setToRoster}
          rosterPlayerIds={toRosterIds}
          rosterLabel="From team"
        />
      </div>

      {verdict && (
        <VerdictCard
          verdict={verdict}
          giving={g}
          getting={r}
          givingHasMarket={giving.some((p) => p.hasMarket)}
          gettingHasMarket={getting.some((p) => p.hasMarket)}
        />
      )}
    </>
  );
}

function TradeSide({
  title,
  accent,
  players,
  taken,
  side,
  setSide,
  summary,
  leagueMode,
  rosterOptions,
  selectedRosterId,
  setSelectedRosterId,
  rosterPlayerIds,
  rosterLabel,
}: {
  title: string;
  accent: "rose" | "emerald";
  players: TradePlayer[];
  taken: Set<string>;
  side: TradePlayer[];
  setSide: (v: TradePlayer[]) => void;
  summary: { dpv: number; var_: number; avgAge: number | null };
  leagueMode: boolean;
  rosterOptions: LeagueRosterOption[];
  selectedRosterId: number | null;
  setSelectedRosterId: (v: number | null) => void;
  rosterPlayerIds: Set<string> | null;
  rosterLabel: string;
}) {
  const [query, setQuery] = useState("");

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Picks aren't tracked per-roster yet, so they remain tradeable regardless
    // of which team the user has scoped the search to.
    const pool = players
      .filter((p) => !taken.has(p.id))
      .filter((p) =>
        rosterPlayerIds ? rosterPlayerIds.has(p.id) || p.position === "PICK" : true,
      );
    if (!q && !rosterPlayerIds) return [];
    if (!q && rosterPlayerIds) return pool.slice(0, 25);
    return pool.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 12);
  }, [query, players, taken, rosterPlayerIds]);

  const badgeColor =
    accent === "rose"
      ? "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"
      : "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="flex items-center gap-2">
          <span
            className={`text-xs uppercase tracking-wider font-semibold px-2 py-0.5 rounded ${badgeColor}`}
          >
            {title}
          </span>
          <span className="text-xs text-zinc-500">
            {side.length} player{side.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold tabular-nums">{summary.dpv}</div>
          <div className="text-xs text-zinc-500">
            VAR {Math.round(summary.var_)}
            {summary.avgAge !== null &&
              ` · avg age ${summary.avgAge.toFixed(1)}`}
          </div>
        </div>
      </div>

      {leagueMode && (
        <div className="mb-3">
          <label className="text-xs text-zinc-500 block mb-1">
            {rosterLabel}
          </label>
          <select
            value={selectedRosterId ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setSelectedRosterId(v ? Number(v) : null);
            }}
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm"
          >
            <option value="">— anyone —</option>
            {rosterOptions.map((r) => (
              <option key={r.rosterId} value={r.rosterId}>
                {r.ownerName}
                {r.teamName ? ` (${r.teamName})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="relative mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={
            rosterPlayerIds
              ? "Filter this roster..."
              : "Search player to add..."
          }
          className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm"
        />
        {matches.length > 0 && (
          <div className="absolute z-10 mt-1 w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-lg overflow-hidden max-h-80 overflow-y-auto">
            {matches.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => {
                  setSide([...side, p]);
                  setQuery("");
                }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center justify-between gap-3"
              >
                <span className="flex items-center gap-2">
                  <span className="font-medium">{p.name}</span>
                  <span
                    className={`text-xs rounded px-1.5 py-0.5 font-mono ${
                      p.position === "PICK"
                        ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                        : "bg-zinc-100 dark:bg-zinc-800"
                    }`}
                  >
                    {p.position}
                  </span>
                  {p.position !== "PICK" && (
                    <span className="text-xs text-zinc-500">
                      {p.team ?? "—"}
                    </span>
                  )}
                  {(() => {
                    const b = buySellBadge(p.marketDelta);
                    return b ? (
                      <span
                        className={`text-[10px] font-bold tracking-wider px-1 py-0.5 rounded ${BUY_SELL_CLASS[b.tone]}`}
                      >
                        {b.label}
                      </span>
                    ) : null;
                  })()}
                </span>
                <span className="tabular-nums font-semibold">{p.dpv}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {side.length === 0 ? (
        <div className="text-sm text-zinc-400 py-4 text-center">
          No players added.
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {side.map((p, i) => {
            const isPick = p.position === "PICK";
            return (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                {(() => {
                  if (isPick) {
                    return <span className="font-medium truncate">{p.name}</span>;
                  }
                  // Synthetic rookies use ID prefix `rookie:<prospect_id>` and
                  // don't have a /player/[id] page yet — link them to the
                  // prospect detail. Real player IDs go to /player/[id].
                  const href = p.id.startsWith("rookie:")
                    ? `/prospect/${p.id.slice("rookie:".length)}`
                    : `/player/${p.id}`;
                  return (
                    <Link
                      href={href}
                      className="font-medium hover:underline truncate"
                    >
                      {p.name}
                    </Link>
                  );
                })()}
                <span
                  className={`text-xs rounded px-1.5 py-0.5 font-mono flex-shrink-0 ${
                    isPick
                      ? "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
                      : "bg-zinc-100 dark:bg-zinc-800"
                  }`}
                >
                  {p.position}
                </span>
                {!isPick && (
                  <span className="text-xs text-zinc-500 flex-shrink-0">
                    {p.team ?? "—"} · {p.age ?? "—"}
                  </span>
                )}
                {(() => {
                  const b = buySellBadge(p.marketDelta);
                  return b ? (
                    <span
                      className={`text-[10px] font-bold tracking-wider px-1 py-0.5 rounded flex-shrink-0 ${BUY_SELL_CLASS[b.tone]}`}
                      title={
                        b.tone === "buy"
                          ? "DPV ranks this player higher than the market"
                          : "Market ranks this player higher than DPV"
                      }
                    >
                      {b.label}
                    </span>
                  ) : null;
                })()}
              </div>
              <div className="flex items-center gap-3 flex-shrink-0">
                <span className="tabular-nums font-semibold">{p.dpv}</span>
                <button
                  type="button"
                  onClick={() =>
                    setSide(side.filter((_, idx) => idx !== i))
                  }
                  className="text-zinc-400 hover:text-rose-600 dark:hover:text-rose-400 text-sm"
                  aria-label={`Remove ${p.name}`}
                >
                  ×
                </button>
              </div>
            </li>
          );
          })}
        </ul>
      )}
    </div>
  );
}

function VerdictCard({
  verdict,
  giving,
  getting,
  givingHasMarket,
  gettingHasMarket,
}: {
  verdict: Verdict;
  giving: { dpv: number; market: number; var_: number };
  getting: { dpv: number; market: number; var_: number };
  givingHasMarket: boolean;
  gettingHasMarket: boolean;
}) {
  const toneClasses: Record<Verdict["tone"], string> = {
    win_big:
      "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100",
    win: "border-emerald-200 bg-emerald-50/60 text-emerald-900 dark:border-emerald-900/70 dark:bg-emerald-950/30 dark:text-emerald-100",
    fair: "border-zinc-200 bg-zinc-50 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100",
    loss: "border-rose-200 bg-rose-50/60 text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/30 dark:text-rose-100",
    loss_big:
      "border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-100",
  };

  // Only render the market axis line if at least one side actually has any
  // FantasyCalc-priced players. Picks-only or unranked-rookie-only trades
  // would show market = dpv on both sides (sub-option C fallback) which is
  // misleading.
  const showMarketAxis = givingHasMarket || gettingHasMarket;

  const dpvDelta = getting.dpv - giving.dpv;
  const mktDelta = getting.market - giving.market;
  const fmtDelta = (n: number) =>
    n > 0 ? `+${Math.round(n)}` : `${Math.round(n)}`;
  const fmtPct = (n: number) =>
    n > 0 ? `+${Math.round(n * 100)}%` : `${Math.round(n * 100)}%`;

  // Color the per-axis pct so the user can see at a glance which axis is
  // pulling the verdict which way. Independent from the overall card tone.
  const pctColor = (pct: number) =>
    pct > 0.05
      ? "text-emerald-700 dark:text-emerald-300"
      : pct < -0.05
        ? "text-rose-700 dark:text-rose-300"
        : "text-zinc-500";

  return (
    <div className={`rounded-md border-2 p-5 ${toneClasses[verdict.tone]}`}>
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-2">
        <div className="text-2xl font-bold tracking-tight">
          {verdict.label}
        </div>
        <div className="text-xs uppercase tracking-wider opacity-70">
          Two-axis verdict
        </div>
      </div>
      <div className="text-sm italic mb-3 opacity-90">{verdict.flavor}</div>

      <div className="rounded-md bg-white/60 dark:bg-zinc-950/40 border border-current/10 p-3 mb-3 text-sm tabular-nums">
        <div className="grid grid-cols-[auto_1fr_1fr_auto] gap-x-4 gap-y-1 items-baseline">
          <div className="text-xs uppercase tracking-wider opacity-60">
            Axis
          </div>
          <div className="text-xs uppercase tracking-wider opacity-60">
            Giving
          </div>
          <div className="text-xs uppercase tracking-wider opacity-60">
            Getting
          </div>
          <div className="text-xs uppercase tracking-wider opacity-60 text-right">
            Δ
          </div>

          <div className="font-medium">VAR (scarcity-adjusted)</div>
          <div>{Math.round(giving.var_).toLocaleString()}</div>
          <div>{Math.round(getting.var_).toLocaleString()}</div>
          <div className={`text-right font-semibold ${pctColor(verdict.dpvPct)}`}>
            {fmtDelta(getting.var_ - giving.var_)} · {fmtPct(verdict.dpvPct)}
          </div>

          <div className="font-medium opacity-70">DPV (raw)</div>
          <div className="opacity-70">{Math.round(giving.dpv).toLocaleString()}</div>
          <div className="opacity-70">{Math.round(getting.dpv).toLocaleString()}</div>
          <div className="text-right opacity-70">
            {fmtDelta(dpvDelta)}
          </div>

          {showMarketAxis ? (
            <>
              <div className="font-medium">Market (price)</div>
              <div>{Math.round(giving.market).toLocaleString()}</div>
              <div>{Math.round(getting.market).toLocaleString()}</div>
              <div
                className={`text-right font-semibold ${pctColor(verdict.marketPct)}`}
              >
                {fmtDelta(mktDelta)} · {fmtPct(verdict.marketPct)}
              </div>
            </>
          ) : (
            <>
              <div className="font-medium opacity-60">Market (price)</div>
              <div className="opacity-60 col-span-3 italic text-xs">
                No FantasyCalc data on either side (picks or unranked rookies
                only) — falling back to DPV verdict.
              </div>
            </>
          )}
        </div>
      </div>

      <div className="text-sm">{verdict.explanation}</div>
    </div>
  );
}

// Scarcity panel — surfaces the replacement cliff used by the verdict so a
// user can see *why* the same DPV totals at different positions read
// differently. Especially relevant for SF / 2QB leagues where QB scarcity
// shifts dramatically vs. 1-QB defaults.
function ScarcityPanel({
  replacement,
  teamCount,
  rosterPositions,
  isDefault,
}: {
  replacement: ReplacementByPosition;
  teamCount: number;
  rosterPositions: string[] | null;
  isDefault: boolean;
  leagueName: string | null;
}) {
  // Surface SF/2QB explicitly — that's the single biggest construction
  // signal that flips trade outcomes vs. a default 1-QB build.
  const isSuperFlex = (rosterPositions ?? []).some(
    (s) => s.toUpperCase() === "SUPER_FLEX" || s.toUpperCase() === "QB_WR_RB_TE",
  );
  const qbStarters = (rosterPositions ?? []).filter(
    (s) => s.toUpperCase() === "QB",
  ).length;

  let constructionLabel: string;
  if (isDefault) {
    constructionLabel = "Standard 12-team 1-QB (default — no league selected)";
  } else if (isSuperFlex) {
    constructionLabel = `${teamCount}-team Super-Flex`;
  } else if (qbStarters >= 2) {
    constructionLabel = `${teamCount}-team ${qbStarters}-QB`;
  } else {
    constructionLabel = `${teamCount}-team 1-QB`;
  }

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50/60 dark:bg-zinc-900/60 p-3 mb-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
        <div className="text-xs uppercase tracking-wider font-semibold text-zinc-600 dark:text-zinc-400">
          Position scarcity (replacement cliff)
        </div>
        <div className="text-xs text-zinc-500">{constructionLabel}</div>
      </div>
      <div className="grid grid-cols-4 gap-2 text-sm tabular-nums">
        {(["QB", "RB", "WR", "TE"] as const).map((pos) => (
          <div
            key={pos}
            className="rounded border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-2 py-1.5"
          >
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">
              {pos} repl.
            </div>
            <div className="font-semibold">
              {replacement[pos].toLocaleString()}
            </div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-zinc-500 mt-2 leading-snug">
        Verdict math is on VAR (DPV minus the replacement cliff at each
        position). A 9000-DPV TE in a 1-TE league trades for more than a
        9000-DPV QB in a 1-QB league because the TE cliff sits much lower.
      </div>
    </div>
  );
}
