"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { ScoringFormat } from "@/lib/dpv/types";

export type TradePlayer = {
  id: string;
  name: string;
  position: string;
  team: string | null;
  age: number | null;
  dpv: number;
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

// Rough replacement-level DPV per position. Trading 2 mid-tier RBs for 1 RB1
// isn't equal-value even if the sums match — elite starters are scarcer.
// Multiply "value above replacement" instead of raw DPV to account for this.
const REPLACEMENT: Record<string, number> = {
  QB: 4500,
  RB: 3500,
  WR: 3500,
  TE: 3000,
};

function valueAboveReplacement(p: TradePlayer): number {
  const repl = REPLACEMENT[p.position] ?? 3500;
  return Math.max(0, p.dpv - repl);
}

function sideValue(side: TradePlayer[]): {
  dpv: number;
  var_: number;
  avgAge: number | null;
} {
  const dpv = side.reduce((a, b) => a + b.dpv, 0);
  const var_ = side.reduce((a, b) => a + valueAboveReplacement(b), 0);
  const ages = side.map((p) => p.age).filter((x): x is number => x !== null);
  const avgAge = ages.length
    ? ages.reduce((a, b) => a + b, 0) / ages.length
    : null;
  return { dpv, var_, avgAge };
}

type Verdict = {
  label: string;
  flavor: string;
  explanation: string;
  tone: "win_big" | "win" | "fair" | "loss" | "loss_big";
};

function verdictFor(
  giving: TradePlayer[],
  getting: TradePlayer[],
): Verdict | null {
  if (giving.length === 0 || getting.length === 0) return null;
  const g = sideValue(giving);
  const r = sideValue(getting);

  // Base the verdict on raw DPV — it already includes positional scarcity
  // via the scarcity tier modifier. Layering a hard VAR floor on top
  // double-penalized mid-tier players whose DPV sat below replacement.
  const denom = Math.max(g.dpv, r.dpv, 1);
  const pct = (r.dpv - g.dpv) / denom;

  const ageDelta =
    g.avgAge !== null && r.avgAge !== null ? r.avgAge - g.avgAge : 0;
  const ageNote =
    Math.abs(ageDelta) >= 1.5
      ? ageDelta > 0
        ? ` Your return is ${ageDelta.toFixed(1)} yrs older on average — factor in dynasty shelf life.`
        : ` Your return is ${(-ageDelta).toFixed(1)} yrs younger on average — small long-term boost.`
      : "";

  if (pct >= 0.25) {
    return {
      label: "Subway King Trade",
      flavor:
        "\"Dang ol' footlong, man, I tell you what.\" You're walking out with way more than you gave up.",
      explanation: `You gain ${Math.round(pct * 100)}% more DPV than you give up. Accept before they notice.${ageNote}`,
      tone: "win_big",
    };
  }
  if (pct >= 0.1) {
    return {
      label: "Solid Win",
      flavor: "Clear lean in your favor.",
      explanation: `You come out ${Math.round(pct * 100)}% ahead on total DPV.${ageNote}`,
      tone: "win",
    };
  }
  if (pct > -0.1) {
    return {
      label: "Fair Trade",
      flavor: "Roughly balanced — depends on your roster needs.",
      explanation: `Within ${Math.round(Math.abs(pct) * 100)}% either way on value. If this fills a hole or consolidates roster spots, take it.${ageNote}`,
      tone: "fair",
    };
  }
  if (pct > -0.25) {
    return {
      label: "Lean Reject",
      flavor: "Tilted against you.",
      explanation: `You lose ${Math.round(-pct * 100)}% of value. Ask for a throw-in or pass.${ageNote}`,
      tone: "loss",
    };
  }
  return {
    label: "Bobby Hill Trade",
    flavor:
      "\"Son, that dog won't hunt.\" This is lopsided against you — pure giveaway.",
    explanation: `You're giving up ${Math.round(-pct * 100)}% more value than you're getting back. Walk away and don't look back.${ageNote}`,
    tone: "loss_big",
  };
}

export default function TradeCalculator({
  players,
  fmt,
  leagueId,
  rosterOptions,
  defaultFromRosterId,
}: {
  players: TradePlayer[];
  fmt: ScoringFormat;
  leagueId: string | null;
  rosterOptions: LeagueRosterOption[];
  defaultFromRosterId: number | null;
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

  const verdict = verdictFor(giving, getting);
  const g = sideValue(giving);
  const r = sideValue(getting);

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
        <VerdictCard verdict={verdict} giving={g} getting={r} />
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
    const pool = players
      .filter((p) => !taken.has(p.id))
      .filter((p) => (rosterPlayerIds ? rosterPlayerIds.has(p.id) : true));
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
                  <span className="text-xs rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono">
                    {p.position}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {p.team ?? "—"}
                  </span>
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
          {side.map((p, i) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="flex items-center gap-2 min-w-0">
                <Link
                  href={`/player/${p.id}`}
                  className="font-medium hover:underline truncate"
                >
                  {p.name}
                </Link>
                <span className="text-xs rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 font-mono flex-shrink-0">
                  {p.position}
                </span>
                <span className="text-xs text-zinc-500 flex-shrink-0">
                  {p.team ?? "—"} · {p.age ?? "—"}
                </span>
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
          ))}
        </ul>
      )}
    </div>
  );
}

function VerdictCard({
  verdict,
  giving,
  getting,
}: {
  verdict: Verdict;
  giving: { dpv: number; var_: number };
  getting: { dpv: number; var_: number };
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

  return (
    <div
      className={`rounded-md border-2 p-5 ${toneClasses[verdict.tone]}`}
    >
      <div className="flex items-baseline justify-between flex-wrap gap-3 mb-2">
        <div className="text-2xl font-bold tracking-tight">
          {verdict.label}
        </div>
        <div className="text-sm tabular-nums opacity-80">
          Giving {giving.dpv} · Getting {getting.dpv} · Δ{" "}
          {getting.dpv - giving.dpv > 0
            ? `+${getting.dpv - giving.dpv}`
            : getting.dpv - giving.dpv}
        </div>
      </div>
      <div className="text-sm italic mb-2 opacity-90">{verdict.flavor}</div>
      <div className="text-sm">{verdict.explanation}</div>
    </div>
  );
}
