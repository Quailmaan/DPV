import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import type { ScoringFormat } from "@/lib/dpv/types";

type SearchParams = Promise<{
  fmt?: string;
  pos?: string;
  q?: string;
}>;

const FORMATS: { key: ScoringFormat; label: string }[] = [
  { key: "STANDARD", label: "Standard" },
  { key: "HALF_PPR", label: "Half PPR" },
  { key: "FULL_PPR", label: "Full PPR" },
];

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE"] as const;

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

export default async function RankingsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";
  const pos = (sp.pos || "ALL").toUpperCase();
  const q = (sp.q ?? "").trim();

  const sb = createServerClient();
  const [snapshotsRes, marketRes] = await Promise.all([
    sb
      .from("dpv_snapshots")
      .select(
        "dpv, tier, player_id, players(name, position, current_team, birthdate)",
      )
      .eq("scoring_format", fmt)
      .order("dpv", { ascending: false }),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", fmt)
      .eq("source", "fantasycalc"),
  ]);

  if (snapshotsRes.error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900 dark:bg-red-950/40 dark:text-red-200">
        <p className="font-medium">Could not load rankings</p>
        <pre className="text-xs mt-2 opacity-80">{snapshotsRes.error.message}</pre>
      </div>
    );
  }

  const snapshots = snapshotsRes.data;
  const marketByPlayer = new Map<string, number>();
  for (const m of marketRes.data ?? []) {
    if (m.market_value_normalized !== null) {
      marketByPlayer.set(m.player_id, Number(m.market_value_normalized));
    }
  }

  // Rank both DPV and market within the intersection of players (both have
  // values), so the delta is rank-based and scale-free.
  const intersect = (snapshots ?? []).filter((s) =>
    marketByPlayer.has(s.player_id),
  );
  const dpvRanks = new Map<string, number>();
  [...intersect]
    .sort((a, b) => b.dpv - a.dpv)
    .forEach((s, i) => dpvRanks.set(s.player_id, i + 1));
  const mktRanks = new Map<string, number>();
  [...intersect]
    .sort(
      (a, b) =>
        (marketByPlayer.get(b.player_id) ?? 0) -
        (marketByPlayer.get(a.player_id) ?? 0),
    )
    .forEach((s, i) => mktRanks.set(s.player_id, i + 1));

  type Row = {
    dpv: number;
    tier: string;
    player_id: string;
    players: {
      name: string;
      position: string;
      current_team: string | null;
      birthdate: string | null;
    } | null;
  };

  const rows = (snapshots ?? []) as unknown as Row[];

  // Position rank assigned against the FULL position group (before filters),
  // so search/filter doesn't renumber. Snapshots come sorted by DPV desc.
  const positionRanks = new Map<string, number>();
  const posCounters = new Map<string, number>();
  for (const r of rows) {
    if (!r.players) continue;
    const p = r.players.position;
    const next = (posCounters.get(p) ?? 0) + 1;
    posCounters.set(p, next);
    positionRanks.set(r.player_id, next);
  }

  const filtered = rows
    .filter((r) => r.players)
    .filter((r) => (pos === "ALL" ? true : r.players!.position === pos))
    .filter((r) =>
      q ? r.players!.name.toLowerCase().includes(q.toLowerCase()) : true,
    )
    .slice(0, 300);

  function ageFrom(bd: string | null): string {
    if (!bd) return "—";
    const years =
      (Date.now() - new Date(bd).getTime()) /
      (365.25 * 24 * 3600 * 1000);
    return years.toFixed(1);
  }

  const buildHref = (updates: Partial<{ fmt: string; pos: string; q: string }>) => {
    const params = new URLSearchParams();
    const next = { fmt, pos, q, ...updates };
    if (next.fmt !== "HALF_PPR") params.set("fmt", next.fmt);
    if (next.pos && next.pos !== "ALL") params.set("pos", next.pos);
    if (next.q) params.set("q", next.q);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Dynasty Rankings
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          DPV score combines weighted production, age curve, opportunity,
          situation, consistency, and market calibration.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {FORMATS.map((f) => (
            <Link
              key={f.key}
              href={buildHref({ fmt: f.key })}
              className={`px-3 py-1.5 ${
                fmt === f.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {POSITIONS.map((p) => (
            <Link
              key={p}
              href={buildHref({ pos: p })}
              className={`px-3 py-1.5 ${
                pos === p
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
        <form className="flex-1 min-w-[180px]" action="/">
          <input type="hidden" name="fmt" value={fmt === "HALF_PPR" ? "" : fmt} />
          <input type="hidden" name="pos" value={pos === "ALL" ? "" : pos} />
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search player..."
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
          />
        </form>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-sm text-zinc-500">
          No DPV snapshots yet.{" "}
          <span className="text-zinc-700 dark:text-zinc-300">
            Run <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs">npx tsx scripts/compute-dpv.ts</code> after ingestion.
          </span>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left w-16">#</th>
                <th className="px-4 py-2 text-left">Player</th>
                <th className="px-4 py-2 text-left w-16">Pos</th>
                <th className="px-4 py-2 text-left w-20">Team</th>
                <th className="px-4 py-2 text-right w-16">Age</th>
                <th className="px-4 py-2 text-right w-24">DPV</th>
                <th className="px-4 py-2 text-right w-24">Market</th>
                <th className="px-4 py-2 text-right w-20">Δ</th>
                <th className="px-4 py-2 text-left w-36">Tier</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const market = marketByPlayer.get(r.player_id);
                const dpvRank = dpvRanks.get(r.player_id);
                const mktRank = mktRanks.get(r.player_id);
                const delta =
                  dpvRank !== undefined && mktRank !== undefined
                    ? mktRank - dpvRank
                    : null;
                const posRank = positionRanks.get(r.player_id);
                return (
                  <tr
                    key={r.player_id}
                    className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  >
                    <td className="px-4 py-2 text-zinc-400 tabular-nums">
                      {posRank !== undefined
                        ? `${r.players!.position}${posRank}`
                        : "—"}
                    </td>
                    <td className="px-4 py-2 font-medium">
                      <Link
                        href={`/player/${r.player_id}?fmt=${fmt}`}
                        className="hover:underline"
                      >
                        {r.players!.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                        {r.players!.position}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-zinc-500">
                      {r.players!.current_team ?? "—"}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {ageFrom(r.players!.birthdate)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold">
                      {r.dpv}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-zinc-500">
                      {market !== undefined ? Math.round(market) : "—"}
                    </td>
                    <td
                      className={`px-4 py-2 text-right tabular-nums ${
                        delta === null
                          ? "text-zinc-400"
                          : delta > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : delta < 0
                          ? "text-rose-600 dark:text-rose-400"
                          : "text-zinc-500"
                      }`}
                      title={
                        delta === null
                          ? "No market data"
                          : delta > 0
                          ? `DPV ranks ${delta} spots higher than market (potential buy)`
                          : delta < 0
                          ? `Market ranks ${-delta} spots higher than DPV (potential sell)`
                          : "Same rank in DPV and market"
                      }
                    >
                      {delta === null
                        ? "—"
                        : delta > 0
                        ? `+${delta}`
                        : `${delta}`}
                    </td>
                    <td className="px-4 py-2 text-zinc-500">{r.tier}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
