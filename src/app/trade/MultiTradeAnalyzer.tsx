"use client";

// Multi-team trade analyzer UI.
//
// The component handles two main states:
//
//   1. Setup — pick a league. Once chosen, it server-loads rosters +
//      picks (parent does this and feeds us via props).
//   2. Build — per-team panels, each with a roster selector and an
//      asset picker scoped to that team. "+ Add team" up to 6.
//
// The "to" destination on each asset row is hidden in 2-team trades
// (auto-targets the other team) and shown for 3+. That keeps 1-on-1
// from feeling clunky while preserving precision when more teams
// participate.
//
// Analyzing is a server action; the result renders inline below.

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useMemo,
  useState,
  useTransition,
} from "react";
import {
  analyzeMultiTrade,
  type AnalyzerLeagueData,
  type AnalyzerRoster,
  type AnalyzerRosterAsset,
  type LeagueOption,
} from "./multiTradeActions";
import type {
  AnalyzeTradeInput,
  AnalyzeTradeResult,
  PricedAsset,
  TeamSummary,
} from "@/lib/multi-trade/types";

// ---- Component ------------------------------------------------------------

type Props = {
  /** Whether the user is on Pro tier — controls inline upgrade banner. */
  isPro: boolean;
  /** All synced leagues for this user; populated server-side. */
  myLeagues: LeagueOption[];
  /** When set, the parent has already loaded league rosters. */
  leagueData: AnalyzerLeagueData | null;
};

// Internal state shape. Send rows always carry an explicit toRosterId:
// in 2-team mode the UI hides the picker and auto-fills it; with 3+
// teams the user picks per row.
type SendRow = { assetId: string; toRosterId: number | null };
type TeamSlot = { rosterId: number | null; sends: SendRow[] };

const MAX_TEAMS = 6;
const MIN_TEAMS = 2;

export default function MultiTradeAnalyzer({
  isPro,
  myLeagues,
  leagueData,
}: Props) {
  const router = useRouter();
  const [pending, startServerTransition] = useTransition();

  const [teams, setTeams] = useState<TeamSlot[]>(() => [
    { rosterId: null, sends: [] },
    { rosterId: null, sends: [] },
  ]);
  const [result, setResult] = useState<AnalyzeTradeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset state if the league changes — IDs would be stale otherwise.
  // Hash on leagueId to make the dependency cheap.
  const leagueKey = leagueData?.leagueId ?? "";
  useMemo(() => {
    setTeams([
      { rosterId: null, sends: [] },
      { rosterId: null, sends: [] },
    ]);
    setResult(null);
    setError(null);
  }, [leagueKey]);

  // ---- gates ----

  if (!isPro) {
    return (
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6">
        <h2 className="text-lg font-semibold mb-1">
          Multi-Team Trade Analyzer
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
          Analyze 2-, 3-, and N-team trades using the same PYV/market blend
          the trade finder uses. League-aware: pulls your synced rosters,
          picks, and per-asset sell-window verdicts.
        </p>
        <Link
          href="/pricing"
          className="inline-flex items-center text-sm font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
        >
          Upgrade to Pro →
        </Link>
      </div>
    );
  }

  if (myLeagues.length === 0) {
    return (
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-6">
        <h2 className="text-lg font-semibold mb-1">
          Multi-Team Trade Analyzer
        </h2>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-3">
          Sync a league first — the analyzer needs your rosters and picks
          to price the assets correctly.
        </p>
        <Link
          href="/league"
          className="inline-flex items-center text-sm font-medium text-emerald-700 dark:text-emerald-400 hover:underline"
        >
          Sync a league →
        </Link>
      </div>
    );
  }

  // ---- league picker ----

  function changeLeague(leagueId: string) {
    const params = new URLSearchParams();
    params.set("tool", "multi");
    if (leagueId) params.set("league", leagueId);
    startTransition(() => router.replace(`/trade?${params.toString()}`));
  }

  if (!leagueData) {
    return (
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">
            Choose a league
          </label>
          <select
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
            defaultValue=""
            onChange={(e) => changeLeague(e.target.value)}
          >
            <option value="" disabled>
              Select a league…
            </option>
            {myLeagues.map((l) => (
              <option key={l.leagueId} value={l.leagueId}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-zinc-500">
          Once selected, you can build a 2-, 3-, or up-to-6-team trade.
        </p>
      </div>
    );
  }

  // ---- builder helpers ----

  const rostersById = new Map<number, AnalyzerRoster>();
  for (const r of leagueData.rosters) rostersById.set(r.rosterId, r);

  // Roster IDs already chosen by some team — used to disable them in
  // sibling pickers so you can't put the same team in twice.
  const chosenRosterIds = new Set(
    teams.map((t) => t.rosterId).filter((id): id is number => id !== null),
  );

  function setTeamRoster(idx: number, rosterId: number | null) {
    setTeams((prev) => {
      const next = prev.slice();
      // If the roster changed, drop sends — those assetIds belong to the
      // old team's roster.
      const sends = next[idx].rosterId === rosterId ? next[idx].sends : [];
      next[idx] = { rosterId, sends };
      // Clean up any other team's send rows that targeted this roster
      // (toRosterId no longer valid if we're nulling).
      if (rosterId === null) {
        for (let i = 0; i < next.length; i++) {
          next[i] = {
            ...next[i],
            sends: next[i].sends.filter(
              (s) => s.toRosterId !== prev[idx].rosterId,
            ),
          };
        }
      }
      return next;
    });
    setResult(null);
  }

  function addTeam() {
    if (teams.length >= MAX_TEAMS) return;
    setTeams((prev) => [...prev, { rosterId: null, sends: [] }]);
    setResult(null);
  }

  function removeTeam(idx: number) {
    if (teams.length <= MIN_TEAMS) return;
    setTeams((prev) => {
      const removedRosterId = prev[idx].rosterId;
      const next = prev.filter((_, i) => i !== idx);
      // Drop any send rows that pointed to the removed team.
      if (removedRosterId !== null) {
        for (let i = 0; i < next.length; i++) {
          next[i] = {
            ...next[i],
            sends: next[i].sends.filter(
              (s) => s.toRosterId !== removedRosterId,
            ),
          };
        }
      }
      return next;
    });
    setResult(null);
  }

  function addSend(teamIdx: number, assetId: string) {
    setTeams((prev) => {
      const next = prev.slice();
      const t = next[teamIdx];
      if (t.sends.some((s) => s.assetId === assetId)) return prev; // dedupe
      // Default toRosterId: in 2-team mode, the other team. In 3+ team,
      // null (user must pick).
      let defaultTo: number | null = null;
      if (next.length === 2) {
        const otherIdx = teamIdx === 0 ? 1 : 0;
        defaultTo = next[otherIdx].rosterId;
      }
      next[teamIdx] = {
        ...t,
        sends: [...t.sends, { assetId, toRosterId: defaultTo }],
      };
      return next;
    });
    setResult(null);
  }

  function removeSend(teamIdx: number, assetId: string) {
    setTeams((prev) => {
      const next = prev.slice();
      next[teamIdx] = {
        ...next[teamIdx],
        sends: next[teamIdx].sends.filter((s) => s.assetId !== assetId),
      };
      return next;
    });
    setResult(null);
  }

  function setSendDestination(
    teamIdx: number,
    assetId: string,
    toRosterId: number | null,
  ) {
    setTeams((prev) => {
      const next = prev.slice();
      next[teamIdx] = {
        ...next[teamIdx],
        sends: next[teamIdx].sends.map((s) =>
          s.assetId === assetId ? { ...s, toRosterId } : s,
        ),
      };
      return next;
    });
    setResult(null);
  }

  // ---- analyze ----

  // Compose the AnalyzeTradeInput from local state. In 2-team mode we
  // auto-fill toRosterId. In N-team mode the user picks; rows missing
  // a destination are excluded with a warning.
  function buildInput(): { input: AnalyzeTradeInput | null; warning: string | null } {
    const teamRosterIds: number[] = [];
    for (const t of teams) {
      if (t.rosterId === null) {
        return { input: null, warning: "Pick a roster for every team slot." };
      }
      teamRosterIds.push(t.rosterId);
    }
    const movements: AnalyzeTradeInput["movements"] = [];
    let missingDest = 0;
    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      for (const s of t.sends) {
        let to = s.toRosterId;
        if (teams.length === 2 && to === null) {
          // Re-derive in case of stale state.
          to = teams[i === 0 ? 1 : 0].rosterId;
        }
        if (to === null) {
          missingDest++;
          continue;
        }
        movements.push({
          assetId: s.assetId,
          fromRosterId: t.rosterId!,
          toRosterId: to,
        });
      }
    }
    if (movements.length === 0) {
      return {
        input: null,
        warning: "Add at least one asset to send for any team.",
      };
    }
    const warning =
      missingDest > 0
        ? `${missingDest} asset${missingDest > 1 ? "s" : ""} missing a destination — fill those in to include them.`
        : null;
    // leagueData is non-null here — we early-returned if it was null at
    // the top of the component. The bang asserts that to TS, which can't
    // preserve narrowing across the nested function boundary.
    return {
      input: {
        leagueId: leagueData!.leagueId,
        teams: teams.map((t) => ({ rosterId: t.rosterId! })),
        movements,
      },
      warning,
    };
  }

  function runAnalyze() {
    setError(null);
    const { input, warning } = buildInput();
    if (!input) {
      setError(warning ?? "Add teams and assets to analyze.");
      return;
    }
    startServerTransition(async () => {
      const r = await analyzeMultiTrade(input);
      if ("error" in r) {
        setError(r.error);
        setResult(null);
        return;
      }
      setError(warning);
      setResult(r);
    });
  }

  // ---- render ----

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[200px]">
          <label className="block text-xs font-medium text-zinc-500 mb-1">
            League
          </label>
          <select
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
            value={leagueData.leagueId}
            onChange={(e) => changeLeague(e.target.value)}
          >
            {myLeagues.map((l) => (
              <option key={l.leagueId} value={l.leagueId}>
                {l.name}
              </option>
            ))}
          </select>
        </div>
        <div className="text-xs text-zinc-500">
          Format:{" "}
          <span className="font-medium text-zinc-700 dark:text-zinc-300">
            {leagueData.scoringFormat.replace("_", " ")}
          </span>
          {" · "}
          k = {leagueData.k.toFixed(3)}
        </div>
      </div>

      <div
        className={
          teams.length === 2
            ? "grid gap-4 md:grid-cols-2"
            : "grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        }
      >
        {teams.map((team, idx) => (
          <TeamPanel
            key={idx}
            idx={idx}
            team={team}
            allTeams={teams}
            rosters={leagueData.rosters}
            chosenRosterIds={chosenRosterIds}
            onSetRoster={(rid) => setTeamRoster(idx, rid)}
            onAddSend={(aid) => addSend(idx, aid)}
            onRemoveSend={(aid) => removeSend(idx, aid)}
            onSetDestination={(aid, to) => setSendDestination(idx, aid, to)}
            onRemoveTeam={
              teams.length > MIN_TEAMS ? () => removeTeam(idx) : null
            }
            rostersById={rostersById}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={addTeam}
          disabled={teams.length >= MAX_TEAMS}
          className="rounded-md border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          + Add team {teams.length >= MAX_TEAMS ? "(max 6)" : ""}
        </button>
        <button
          type="button"
          onClick={runAnalyze}
          disabled={pending}
          className="rounded-md bg-emerald-600 hover:bg-emerald-700 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? "Analyzing…" : "Analyze trade"}
        </button>
        {error && (
          <span className="text-sm text-red-600 dark:text-red-400">
            {error}
          </span>
        )}
      </div>

      {result && <ResultPanel result={result} />}
    </div>
  );
}

// ---- Team panel -----------------------------------------------------------

function TeamPanel({
  idx,
  team,
  allTeams,
  rosters,
  chosenRosterIds,
  onSetRoster,
  onAddSend,
  onRemoveSend,
  onSetDestination,
  onRemoveTeam,
  rostersById,
}: {
  idx: number;
  team: TeamSlot;
  allTeams: TeamSlot[];
  rosters: AnalyzerRoster[];
  chosenRosterIds: Set<number>;
  onSetRoster: (rosterId: number | null) => void;
  onAddSend: (assetId: string) => void;
  onRemoveSend: (assetId: string) => void;
  onSetDestination: (assetId: string, to: number | null) => void;
  onRemoveTeam: (() => void) | null;
  rostersById: Map<number, AnalyzerRoster>;
}) {
  const roster =
    team.rosterId !== null
      ? rosters.find((r) => r.rosterId === team.rosterId) ?? null
      : null;
  const [search, setSearch] = useState("");

  const showDestinationPicker = allTeams.length > 2;

  const availableAssets = useMemo<AnalyzerRosterAsset[]>(() => {
    if (!roster) return [];
    const taken = new Set(team.sends.map((s) => s.assetId));
    const q = search.trim().toLowerCase();
    return roster.assets.filter((a) => {
      if (taken.has(a.assetId)) return false;
      if (!q) return true;
      return (
        a.name.toLowerCase().includes(q) ||
        a.position.toLowerCase().includes(q) ||
        (a.team ?? "").toLowerCase().includes(q)
      );
    });
  }, [roster, search, team.sends]);

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50 p-4 flex flex-col">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1">
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">
            Team {idx + 1}
          </div>
          <select
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-2 text-sm"
            value={team.rosterId ?? ""}
            onChange={(e) =>
              onSetRoster(e.target.value === "" ? null : Number(e.target.value))
            }
          >
            <option value="">Select team…</option>
            {rosters.map((r) => {
              const taken =
                chosenRosterIds.has(r.rosterId) && r.rosterId !== team.rosterId;
              return (
                <option
                  key={r.rosterId}
                  value={r.rosterId}
                  disabled={taken}
                >
                  {r.teamName?.trim() || r.ownerName}
                  {taken ? " (already in trade)" : ""}
                </option>
              );
            })}
          </select>
        </div>
        {onRemoveTeam && (
          <button
            type="button"
            onClick={onRemoveTeam}
            className="rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            title="Remove team"
          >
            ✕
          </button>
        )}
      </div>

      {!roster ? (
        <p className="text-xs text-zinc-500">
          Pick a team to load assets.
        </p>
      ) : (
        <>
          <div className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-1">
            Sending
          </div>
          {team.sends.length === 0 ? (
            <p className="text-xs text-zinc-500 mb-3">
              No assets selected yet.
            </p>
          ) : (
            <ul className="mb-3 space-y-1">
              {team.sends.map((s) => {
                const a = roster.assets.find((x) => x.assetId === s.assetId);
                if (!a) return null;
                return (
                  <li
                    key={s.assetId}
                    className="flex items-center gap-2 text-sm"
                  >
                    <div className="flex-1 min-w-0">
                      <AssetLine asset={a} />
                    </div>
                    {showDestinationPicker && (
                      <select
                        className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-1 py-0.5 text-xs"
                        value={s.toRosterId ?? ""}
                        onChange={(e) =>
                          onSetDestination(
                            s.assetId,
                            e.target.value === ""
                              ? null
                              : Number(e.target.value),
                          )
                        }
                      >
                        <option value="">→ to…</option>
                        {allTeams.map((t, ti) => {
                          if (ti === idx) return null;
                          if (t.rosterId === null) return null;
                          const r = rostersById.get(t.rosterId);
                          return (
                            <option key={t.rosterId} value={t.rosterId}>
                              → {r?.teamName?.trim() || r?.ownerName || `Team ${ti + 1}`}
                            </option>
                          );
                        })}
                      </select>
                    )}
                    <button
                      type="button"
                      onClick={() => onRemoveSend(s.assetId)}
                      className="rounded border border-zinc-200 dark:border-zinc-800 px-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                      title="Remove"
                    >
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search this team's assets…"
            className="mb-2 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
          />
          <div className="flex-1 max-h-64 overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800">
            {availableAssets.length === 0 ? (
              <div className="p-2 text-xs text-zinc-500">
                No assets match.
              </div>
            ) : (
              availableAssets.map((a) => (
                <button
                  key={a.assetId}
                  type="button"
                  onClick={() => onAddSend(a.assetId)}
                  className="w-full text-left px-2 py-1 text-sm hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                >
                  <AssetLine asset={a} />
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

function AssetLine({ asset }: { asset: AnalyzerRosterAsset }) {
  const sub =
    asset.kind === "pick"
      ? asset.tier
      : `${asset.position}${asset.team ? ` · ${asset.team}` : ""}${
          asset.age !== null ? ` · ${asset.age.toFixed(0)}y` : ""
        }`;
  return (
    <div className="flex items-baseline justify-between gap-2 min-w-0">
      <div className="truncate">
        <span className="font-medium">{asset.name}</span>
        <span className="ml-2 text-xs text-zinc-500">{sub}</span>
      </div>
      <div className="text-xs tabular-nums text-zinc-500 shrink-0">
        {asset.pyv.toLocaleString()}
      </div>
    </div>
  );
}

// ---- Result panel ---------------------------------------------------------

function ResultPanel({ result }: { result: AnalyzeTradeResult }) {
  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold">Analysis</h3>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {result.teams.map((t) => (
          <TeamResultCard key={t.rosterId} team={t} />
        ))}
      </div>
      {result.notes.length > 0 && (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900/50 p-3">
          <div className="text-xs font-medium text-zinc-500 uppercase mb-1">
            Notes
          </div>
          <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
            {result.notes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="text-xs text-zinc-500">
        Gate threshold: {(result.gateThreshold * 100).toFixed(0)}% · Market
        scale k = {result.k.toFixed(3)}
      </div>
    </div>
  );
}

const VERDICT_COLOR: Record<TeamSummary["verdict"], string> = {
  winner:
    "border-emerald-300 bg-emerald-50 dark:bg-emerald-950/40 dark:border-emerald-800/60",
  fair:
    "border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900/50",
  loser:
    "border-red-300 bg-red-50 dark:bg-red-950/40 dark:border-red-800/60",
};

const VERDICT_LABEL: Record<TeamSummary["verdict"], string> = {
  winner: "Winner",
  fair: "Fair",
  loser: "Overpaying",
};

function TeamResultCard({ team }: { team: TeamSummary }) {
  const name = team.teamName?.trim() || team.ownerName;
  return (
    <div className={`rounded-md border p-4 ${VERDICT_COLOR[team.verdict]}`}>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="font-semibold">{name}</div>
        <div className="text-xs uppercase tracking-wide font-medium">
          {VERDICT_LABEL[team.verdict]}
          {team.failsGate && team.verdict !== "fair" && " · fails gate"}
        </div>
      </div>
      <div className="text-xs text-zinc-600 dark:text-zinc-400 space-y-0.5 mb-3">
        <div>
          Receive total: <span className="font-medium tabular-nums">{team.receiveTotal.toLocaleString()}</span>
        </div>
        <div>
          Send total: <span className="font-medium tabular-nums">{team.sendTotal.toLocaleString()}</span>
        </div>
        <div>
          Net (blend):{" "}
          <span
            className={
              "font-semibold tabular-nums " +
              (team.netBlend >= 0
                ? "text-emerald-700 dark:text-emerald-400"
                : "text-red-700 dark:text-red-400")
            }
          >
            {team.netBlend >= 0 ? "+" : ""}
            {team.netBlend.toLocaleString()}
          </span>{" "}
          <span className="text-zinc-500">
            ({(team.imbalancePct * 100).toFixed(1)}% imbalance)
          </span>
        </div>
        <div className="text-zinc-500">
          PYV-only net:{" "}
          <span className="tabular-nums">
            {team.netPyv >= 0 ? "+" : ""}
            {team.netPyv.toLocaleString()}
          </span>{" "}
          · Market-only net:{" "}
          <span className="tabular-nums">
            {team.netMarket >= 0 ? "+" : ""}
            {Math.round(team.netMarket).toLocaleString()}
          </span>
        </div>
      </div>

      <AssetSection title="Receives" assets={team.receive} />
      <AssetSection title="Sends" assets={team.send} />
    </div>
  );
}

function AssetSection({
  title,
  assets,
}: {
  title: string;
  assets: PricedAsset[];
}) {
  if (assets.length === 0) return null;
  return (
    <div className="mb-2">
      <div className="text-[10px] font-medium uppercase tracking-wide text-zinc-500 mb-1">
        {title}
      </div>
      <ul className="space-y-1">
        {assets.map((a) => (
          <li
            key={a.assetId + a.fromRosterId + a.toRosterId}
            className="flex items-baseline justify-between gap-2 text-xs"
          >
            <div className="min-w-0 truncate">
              <span className="font-medium">{a.name}</span>
              <span className="ml-1 text-zinc-500">
                {a.kind === "pick" ? "" : a.position}
                {a.sellWindow && (
                  <span
                    className={
                      "ml-1 inline-block rounded px-1 text-[10px] font-medium " +
                      sellToneClass(a.sellWindow.tone)
                    }
                  >
                    {a.sellWindow.label}
                  </span>
                )}
              </span>
            </div>
            <div className="tabular-nums text-zinc-600 dark:text-zinc-400 shrink-0">
              {a.blended.toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function sellToneClass(tone: "bad" | "warn" | "neutral" | "good" | "elite"): string {
  switch (tone) {
    case "bad":
      return "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300";
    case "warn":
      return "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300";
    case "good":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300";
    case "elite":
      return "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300";
    case "neutral":
    default:
      return "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";
  }
}
