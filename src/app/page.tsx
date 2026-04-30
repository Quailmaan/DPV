import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import type { ScoringFormat } from "@/lib/dpv/types";
import { Pagination } from "@/components/Pagination";

const PAGE_SIZE = 25;

type SearchParams = Promise<{
  fmt?: string;
  pos?: string;
  q?: string;
  page?: string;
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
  // Page is 1-indexed in the URL. Clamp ≥ 1; the upper bound is enforced
  // after we know how many filtered rows there are.
  const requestedPage = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);

  // Anonymous-visitor hero only renders when signed-out, so we resolve
  // the session up front. Signed-in users skip the marketing block and
  // go straight to rankings.
  const sb = await createServerClient();
  const [session, snapshotsRes, marketRes] = await Promise.all([
    getCurrentSession(),
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

  const filteredAll = rows
    .filter((r) => r.players)
    .filter((r) => (pos === "ALL" ? true : r.players!.position === pos))
    .filter((r) =>
      q ? r.players!.name.toLowerCase().includes(q.toLowerCase()) : true,
    );

  // Pagination — slice 25 rows per page out of the filtered list. We
  // compute totalPages off the filtered count, clamp the requested page
  // back inside the valid range (so a stale ?page=12 with a fresh filter
  // doesn't render an empty table), and slice.
  const totalItems = filteredAll.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / PAGE_SIZE));
  const currentPage = Math.min(requestedPage, totalPages);
  const filtered = filteredAll.slice(
    (currentPage - 1) * PAGE_SIZE,
    currentPage * PAGE_SIZE,
  );

  function ageFrom(bd: string | null): string {
    if (!bd) return "—";
    const years =
      (Date.now() - new Date(bd).getTime()) /
      (365.25 * 24 * 3600 * 1000);
    return years.toFixed(1);
  }

  // Filter-bar links: any filter change resets pagination back to page 1
  // by intentionally NOT carrying the current `page` value forward.
  const buildHref = (updates: Partial<{ fmt: string; pos: string; q: string }>) => {
    const params = new URLSearchParams();
    const next = { fmt, pos, q, ...updates };
    if (next.fmt !== "HALF_PPR") params.set("fmt", next.fmt);
    if (next.pos && next.pos !== "ALL") params.set("pos", next.pos);
    if (next.q) params.set("q", next.q);
    const s = params.toString();
    return s ? `/?${s}` : "/";
  };

  // Pagination links: keep filters, change only the page param.
  const buildPageHref = (p: number) => {
    const params = new URLSearchParams();
    if (fmt !== "HALF_PPR") params.set("fmt", fmt);
    if (pos && pos !== "ALL") params.set("pos", pos);
    if (q) params.set("q", q);
    if (p > 1) params.set("page", String(p));
    const s = params.toString();
    return s ? `/?${s}` : "/";
  };

  return (
    <div>
      {!session && <MarketingHero />}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Dynasty Rankings
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          PYV score combines weighted production, age curve, opportunity,
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
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700"
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
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700"
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
          No PYV snapshots yet.{" "}
          <span className="text-zinc-700 dark:text-zinc-300">
            Run <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs">npx tsx scripts/compute-dpv.ts</code> after ingestion.
          </span>
        </div>
      ) : (
        // On phones we collapse to the 3 essentials: rank, player, PYV.
        // Pos + Tier come back at sm; Team/Age at md; Market/Δ at lg.
        // `min-w-` only kicks in at lg+ where every column is visible.
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm lg:min-w-[640px]">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-3 sm:px-4 py-2 text-left w-12 sm:w-16">#</th>
                <th className="px-3 sm:px-4 py-2 text-left">Player</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left w-16">Pos</th>
                <th className="hidden md:table-cell px-4 py-2 text-left w-20">Team</th>
                <th className="hidden md:table-cell px-4 py-2 text-right w-16">Age</th>
                <th className="px-3 sm:px-4 py-2 text-right w-16 sm:w-24">PYV</th>
                <th className="hidden lg:table-cell px-4 py-2 text-right w-24">Market</th>
                <th className="hidden lg:table-cell px-4 py-2 text-right w-20">Δ</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left w-36">Tier</th>
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
                    className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 active:bg-zinc-100 dark:active:bg-zinc-800"
                  >
                    <td className="px-3 sm:px-4 py-2 text-zinc-400 tabular-nums">
                      {posRank !== undefined
                        ? `${r.players!.position}${posRank}`
                        : "—"}
                    </td>
                    <td className="px-3 sm:px-4 py-2 font-medium">
                      <Link
                        href={`/player/${r.player_id}?fmt=${fmt}`}
                        className="hover:underline"
                      >
                        {r.players!.name}
                      </Link>
                      {/* On phones the Pos/Team columns are hidden; show
                          a compact "POS · TEAM" line under the name so
                          the row is still self-explanatory. */}
                      <div className="sm:hidden text-xs text-zinc-500 mt-0.5">
                        {r.players!.position}
                        {r.players!.current_team
                          ? ` · ${r.players!.current_team}`
                          : ""}
                      </div>
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2">
                      <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                        {r.players!.position}
                      </span>
                    </td>
                    <td className="hidden md:table-cell px-4 py-2 text-zinc-500">
                      {r.players!.current_team ?? "—"}
                    </td>
                    <td className="hidden md:table-cell px-4 py-2 text-right tabular-nums">
                      {ageFrom(r.players!.birthdate)}
                    </td>
                    <td className="px-3 sm:px-4 py-2 text-right tabular-nums font-semibold">
                      {r.dpv}
                    </td>
                    <td className="hidden lg:table-cell px-4 py-2 text-right tabular-nums text-zinc-500">
                      {market !== undefined ? Math.round(market) : "—"}
                    </td>
                    <td
                      className={`hidden lg:table-cell px-4 py-2 text-right tabular-nums ${
                        delta === null
                          ? "text-zinc-400"
                          : delta > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : delta < 0
                          ? "text-red-600 dark:text-red-400"
                          : "text-zinc-500"
                      }`}
                      title={
                        delta === null
                          ? "No market data"
                          : delta > 0
                          ? `PYV ranks ${delta} spots higher than market (potential buy)`
                          : delta < 0
                          ? `Market ranks ${-delta} spots higher than PYV (potential sell)`
                          : "Same rank in PYV and market"
                      }
                    >
                      {delta === null
                        ? "—"
                        : delta > 0
                        ? `+${delta}`
                        : `${delta}`}
                    </td>
                    <td className="hidden sm:table-cell px-4 py-2 text-zinc-500">{r.tier}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {totalItems > 0 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          pageSize={PAGE_SIZE}
          buildHref={buildPageHref}
          itemLabel="players"
        />
      )}
    </div>
  );
}

// Marketing hero — only rendered for signed-out visitors. The pitch in
// 3 beats: what Pylon is, what makes it different (the data), and what
// you actually do with it (Pro features that turn the data into
// decisions). The actual rankings table sits below the hero so the
// data is visible immediately — the page works as a teaser without
// anyone reading the hero.
function MarketingHero() {
  return (
    <div className="mb-8 rounded-lg border border-emerald-200/70 dark:border-emerald-900/60 bg-gradient-to-br from-emerald-50/80 to-white dark:from-emerald-950/30 dark:to-zinc-950/40 p-6 sm:p-8">
      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-6 items-start">
        <div>
          <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-400 mb-2">
            Dynasty fantasy values, calibrated to your league
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight mb-3">
            Stop guessing whether to trade.
            <span className="block text-zinc-500 text-base sm:text-lg font-normal mt-1">
              Pylon scores every dynasty player on production, age, and
              opportunity, then tells you when to sell, who to target,
              and which trades actually move your team.
            </span>
          </h1>
          <div className="flex flex-wrap gap-2 mt-4">
            <Link
              href="/signup"
              className="inline-block text-sm font-medium px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              Create free account
            </Link>
            <Link
              href="/pricing"
              className="inline-block text-sm font-medium px-4 py-2 rounded-md border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800 active:bg-zinc-200 dark:active:bg-zinc-700"
            >
              See Pro features — $7/mo
            </Link>
          </div>
          <p className="text-xs text-zinc-500 mt-3">
            Free includes the full PYV rankings, rookie board, 1 synced
            Sleeper league, and the universal trade calc. Pro adds the
            decision tools below.
          </p>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white/80 dark:bg-zinc-900/80 p-4 backdrop-blur">
          <div className="text-xs uppercase tracking-wider font-semibold text-zinc-500 mb-3">
            What Pro unlocks
          </div>
          <ul className="text-sm space-y-2">
            <HeroBullet>
              <strong>Sell-window flags</strong> on every player — sell
              now, peak hold, buy
            </HeroBullet>
            <HeroBullet>
              <strong>Roster report card</strong> with composite 0-100
              score per team
            </HeroBullet>
            <HeroBullet>
              <strong>Trade finder</strong> — fair-value ideas tailored
              to your roster
            </HeroBullet>
            <HeroBullet>
              <strong>League-aware trade calc</strong> with traded picks +
              league scoring
            </HeroBullet>
          </ul>
        </div>
      </div>
    </div>
  );
}

function HeroBullet({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg
        className="h-4 w-4 flex-shrink-0 mt-0.5 text-emerald-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12l5 5L20 7" />
      </svg>
      <span className="text-zinc-700 dark:text-zinc-300">{children}</span>
    </li>
  );
}
