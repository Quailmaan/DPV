import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { getCurrentTier } from "@/lib/billing/tier";
import {
  computeReportCards,
  type LeaguePick,
  type Position,
  type ReportPlayer,
  type RosterInput,
} from "@/lib/league/reportCard";
import { createServerClient } from "@/lib/supabase/server";
import type { ScoringFormat } from "@/lib/dpv/types";
import { buildMarketDeltaMap } from "@/lib/dpv/marketDelta";
import {
  computeSellWindow,
  type Position as SellWindowPosition,
} from "@/lib/dpv/sellWindow";
import SellWindowBadge from "@/components/SellWindowBadge";

type SearchParams = Promise<{
  team?: string;
  pos?: string;
}>;

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE"] as const;

export default async function LeagueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const teamFilter = sp.team ?? "";
  const posFilter = (sp.pos ?? "ALL").toUpperCase();

  const session = await getCurrentSession();
  if (!session) redirect(`/login?next=/league/${id}`);

  const sb = await createServerClient();
  // Auth-gate: confirm the user actually subscribed to this league. RLS
  // on user_leagues prevents leakage, so a missing row means "not yours."
  // Admin users can view any league for support / debugging.
  if (!session.isAdmin) {
    const { data: subscription } = await sb
      .from("user_leagues")
      .select("league_id")
      .eq("league_id", id)
      .maybeSingle();
    if (!subscription) redirect("/league");
  }
  const [leagueRes, rostersRes, picksRes, tierState] = await Promise.all([
    sb.from("leagues").select("*").eq("league_id", id).maybeSingle(),
    sb
      .from("league_rosters")
      .select("*")
      .eq("league_id", id)
      .order("roster_id", { ascending: true }),
    sb
      .from("league_picks")
      .select("season, round, owner_roster_id")
      .eq("league_id", id),
    getCurrentTier(),
  ]);

  if (leagueRes.error || !leagueRes.data) return notFound();
  const league = leagueRes.data as {
    league_id: string;
    name: string;
    season: string;
    total_rosters: number;
    scoring_format: ScoringFormat;
    roster_positions: string[] | null;
    synced_at: string;
  };
  const isPro = tierState.tier === "pro";
  // DB returns snake_case (owner_roster_id) — map to the camelCase shape
  // the calculator expects.
  const leaguePicks: LeaguePick[] = (
    (picksRes.data ?? []) as Array<{
      season: number;
      round: number;
      owner_roster_id: number;
    }>
  ).map((p) => ({
    season: p.season,
    round: p.round,
    ownerRosterId: p.owner_roster_id,
  }));
  const rosters = (rostersRes.data ?? []) as Array<{
    league_id: string;
    roster_id: number;
    owner_display_name: string | null;
    team_name: string | null;
    player_ids: string[];
  }>;

  const allRosteredIds = new Set<string>();
  for (const r of rosters) for (const pid of r.player_ids) allRosteredIds.add(pid);

  // Load DPV + player info for every rostered player AND all free-agent
  // candidates (positions we rank). We fetch all ranked players then split.
  // FantasyCalc market values run alongside — they feed the sell-window
  // tags on the focused-team roster.
  const [snapshotsRes, marketRes] = await Promise.all([
    sb
      .from("dpv_snapshots")
      .select(
        "player_id, dpv, tier, players(name, position, current_team, birthdate)",
      )
      .eq("scoring_format", league.scoring_format)
      .order("dpv", { ascending: false }),
    sb
      .from("market_values")
      .select("player_id, market_value_normalized")
      .eq("scoring_format", league.scoring_format)
      .eq("source", "fantasycalc"),
  ]);
  const snapshots = snapshotsRes.data;
  const marketRows = marketRes.data ?? [];

  type Snap = {
    player_id: string;
    dpv: number;
    tier: string;
    players: {
      name: string;
      position: string;
      current_team: string | null;
      birthdate: string | null;
    } | null;
  };

  const snapMap = new Map<string, Snap>();
  for (const s of (snapshots ?? []) as unknown as Snap[]) {
    snapMap.set(s.player_id, s);
  }

  // Per-position rank delta (DPV vs FantasyCalc market). Feeds the
  // sell-window tag on the focused-team roster — same helper powers the
  // trade calc and player pages so the math stays in lockstep.
  const marketByPid = new Map<string, number>();
  for (const m of marketRows as Array<{
    player_id: string;
    market_value_normalized: number | null;
  }>) {
    if (m.market_value_normalized !== null) {
      marketByPid.set(m.player_id, Number(m.market_value_normalized));
    }
  }
  const marketDeltaInput = (snapshots ?? [])
    .map((s) => {
      const player = (s as unknown as Snap).players;
      if (!player) return null;
      return {
        id: s.player_id,
        position: player.position,
        dpv: Number(s.dpv),
        market: marketByPid.get(s.player_id) ?? null,
      };
    })
    .filter((x): x is {
      id: string;
      position: string;
      dpv: number;
      market: number | null;
    } => x !== null);
  const marketDeltaMap = buildMarketDeltaMap(marketDeltaInput);

  // Summarize each roster: total DPV and strengths/weaknesses by position.
  type RosterSummary = {
    rosterId: number;
    ownerName: string;
    teamName: string | null;
    totalDpv: number;
    byPos: Record<"QB" | "RB" | "WR" | "TE", number>;
    topPlayerName: string | null;
    topPlayerDpv: number;
  };

  const summaries: RosterSummary[] = rosters.map((r) => {
    const byPos: Record<"QB" | "RB" | "WR" | "TE", number> = {
      QB: 0,
      RB: 0,
      WR: 0,
      TE: 0,
    };
    let total = 0;
    let topPlayer: Snap | null = null;
    for (const pid of r.player_ids) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position as "QB" | "RB" | "WR" | "TE";
      if (!(pos in byPos)) continue;
      byPos[pos] += s.dpv;
      total += s.dpv;
      if (!topPlayer || s.dpv > topPlayer.dpv) topPlayer = s;
    }
    return {
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
      totalDpv: total,
      byPos,
      topPlayerName: (topPlayer as Snap | null)?.players?.name ?? null,
      topPlayerDpv: (topPlayer as Snap | null)?.dpv ?? 0,
    };
  });
  summaries.sort((a, b) => b.totalDpv - a.totalDpv);

  // League-wide position averages — for flagging roster strengths/weaknesses.
  const leaguePosAvg: Record<"QB" | "RB" | "WR" | "TE", number> = {
    QB: 0,
    RB: 0,
    WR: 0,
    TE: 0,
  };
  for (const s of summaries) {
    leaguePosAvg.QB += s.byPos.QB;
    leaguePosAvg.RB += s.byPos.RB;
    leaguePosAvg.WR += s.byPos.WR;
    leaguePosAvg.TE += s.byPos.TE;
  }
  const nRosters = summaries.length || 1;
  leaguePosAvg.QB /= nRosters;
  leaguePosAvg.RB /= nRosters;
  leaguePosAvg.WR /= nRosters;
  leaguePosAvg.TE /= nRosters;

  // Free agents: ranked players not on any roster.
  const freeAgents = (snapshots ?? [])
    .filter((s) => !allRosteredIds.has(s.player_id))
    .slice(0, 200) as unknown as Snap[];

  const focusedTeam = teamFilter
    ? summaries.find(
        (s) => s.rosterId.toString() === teamFilter || s.ownerName === teamFilter,
      )
    : null;
  const focusedRoster = focusedTeam
    ? rosters.find((r) => r.roster_id === focusedTeam.rosterId) ?? null
    : null;

  // Compute report cards once for every roster — cheap pure-fn pass
  // over data we already have. Used to render verdict badges in the
  // rankings table. The full breakdown (composite + sub-scores) lives
  // on the per-team /report page and is Pro-gated there.
  const picksByRoster = new Map<number, LeaguePick[]>();
  for (const p of leaguePicks) {
    const arr = picksByRoster.get(p.ownerRosterId) ?? [];
    arr.push(p);
    picksByRoster.set(p.ownerRosterId, arr);
  }
  const rosterInputs: RosterInput[] = rosters.map((r) => {
    const players: ReportPlayer[] = [];
    for (const pid of r.player_ids) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") continue;
      players.push({
        playerId: pid,
        name: s.players.name,
        position: pos as Position,
        birthdate: s.players.birthdate,
        dpv: s.dpv,
      });
    }
    return {
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
      players,
      picks: picksByRoster.get(r.roster_id) ?? [],
    };
  });
  const reportCards = computeReportCards(rosterInputs, {
    rosterPositions: league.roster_positions,
    totalRosters: league.total_rosters,
  });
  const cardByRoster = new Map(reportCards.map((c) => [c.rosterId, c]));

  function ageFrom(bd: string | null): string {
    if (!bd) return "—";
    const y =
      (Date.now() - new Date(bd).getTime()) /
      (365.25 * 24 * 3600 * 1000);
    return y.toFixed(1);
  }

  function ageNum(bd: string | null): number | null {
    if (!bd) return null;
    return (
      (Date.now() - new Date(bd).getTime()) /
      (365.25 * 24 * 3600 * 1000)
    );
  }

  const filteredFAs = freeAgents.filter((fa) => {
    if (!fa.players) return false;
    if (posFilter === "ALL") return true;
    return fa.players.position === posFilter;
  });

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/league"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Leagues
        </Link>
      </div>

      <div className="flex items-start justify-between gap-6 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {league.name}
          </h1>
          <div className="text-sm text-zinc-500 mt-1 flex gap-3">
            <span>{league.season}</span>
            <span>·</span>
            <span>{league.scoring_format}</span>
            <span>·</span>
            <span>{league.total_rosters} teams</span>
            <span>·</span>
            <span>
              Synced {new Date(league.synced_at).toLocaleDateString()}
            </span>
          </div>
        </div>
        <form action={`/league/${id}`} className="flex gap-2 items-center">
          <label className="text-xs text-zinc-500">My Team</label>
          <select
            name="team"
            defaultValue={teamFilter}
            className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
          >
            <option value="">— select —</option>
            {summaries.map((s) => (
              <option key={s.rosterId} value={s.rosterId}>
                {s.ownerName}
                {s.teamName ? ` (${s.teamName})` : ""}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm"
          >
            Focus
          </button>
        </form>
      </div>

      <h2 className="text-sm font-semibold mb-3">Power Rankings</h2>
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 mb-8">
        <table className="w-full text-sm min-w-[680px]">
          <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="px-3 py-2 text-left">Team</th>
              <th className="px-3 py-2 text-right">Total PYV</th>
              <th className="px-3 py-2 text-right">QB</th>
              <th className="px-3 py-2 text-right">RB</th>
              <th className="px-3 py-2 text-right">WR</th>
              <th className="px-3 py-2 text-right">TE</th>
              <th className="px-3 py-2 text-left">Top Player</th>
              <th className="px-3 py-2 text-left">Verdict</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {summaries.map((s, i) => {
              const strengthCell = (
                key: "QB" | "RB" | "WR" | "TE",
                val: number,
              ) => {
                const avg = leaguePosAvg[key];
                const diff = avg > 0 ? (val - avg) / avg : 0;
                const cls =
                  diff > 0.2
                    ? "text-emerald-600 dark:text-emerald-400 font-medium"
                    : diff < -0.2
                    ? "text-red-600 dark:text-red-400 font-medium"
                    : "text-zinc-500";
                return (
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${cls}`}
                    title={`${Math.round(val)} (league avg ${Math.round(avg)})`}
                  >
                    {Math.round(val)}
                  </td>
                );
              };
              const isFocus = focusedTeam?.rosterId === s.rosterId;
              return (
                <tr
                  key={s.rosterId}
                  className={`border-t border-zinc-100 dark:border-zinc-800 ${
                    isFocus
                      ? "bg-amber-50/50 dark:bg-amber-950/20"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                  }`}
                >
                  <td className="px-3 py-2 text-zinc-400 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    <Link
                      href={`/league/${id}?team=${s.rosterId}`}
                      className="hover:underline"
                    >
                      {s.ownerName}
                    </Link>
                    {s.teamName && (
                      <span className="text-xs text-zinc-500 ml-2">
                        {s.teamName}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {Math.round(s.totalDpv)}
                  </td>
                  {strengthCell("QB", s.byPos.QB)}
                  {strengthCell("RB", s.byPos.RB)}
                  {strengthCell("WR", s.byPos.WR)}
                  {strengthCell("TE", s.byPos.TE)}
                  <td className="px-3 py-2 text-zinc-500">
                    {s.topPlayerName ?? "—"}
                    {s.topPlayerDpv > 0 && (
                      <span className="text-xs ml-2 tabular-nums">
                        {s.topPlayerDpv}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <VerdictPill
                      tone={cardByRoster.get(s.rosterId)?.tone ?? "neutral"}
                      label={cardByRoster.get(s.rosterId)?.verdict ?? "—"}
                      score={
                        isPro
                          ? cardByRoster.get(s.rosterId)?.composite ?? null
                          : null
                      }
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Link
                      href={`/league/${id}/team/${s.rosterId}/report`}
                      className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline whitespace-nowrap"
                    >
                      Report →
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!isPro && (
        <div className="-mt-6 mb-8 text-xs text-zinc-500">
          Verdict labels are free —{" "}
          <Link
            href="/pricing"
            className="text-emerald-700 dark:text-emerald-400 hover:underline"
          >
            upgrade to Pro
          </Link>{" "}
          to see composite scores, sub-score breakdowns, and recommended
          actions per team.
        </div>
      )}

      {focusedTeam && focusedRoster && (
        <div className="mb-8">
          <h2 className="text-sm font-semibold mb-3">
            {focusedTeam.ownerName} — Roster
          </h2>
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-3 py-2 text-left">Player</th>
                  <th className="px-3 py-2 text-left">Pos</th>
                  <th className="px-3 py-2 text-left">Team</th>
                  <th className="px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2 text-right">PYV</th>
                  <th className="px-3 py-2 text-left">Tier</th>
                  <th className="px-3 py-2 text-left">Window</th>
                </tr>
              </thead>
              <tbody>
                {focusedRoster.player_ids
                  .map((pid) => snapMap.get(pid))
                  .filter((s): s is Snap => !!s && !!s.players)
                  .sort((a, b) => b.dpv - a.dpv)
                  .map((s) => {
                    const pos = s.players!.position;
                    const isFantasyPos =
                      pos === "QB" || pos === "RB" || pos === "WR" || pos === "TE";
                    const sw = isFantasyPos
                      ? computeSellWindow({
                          position: pos as SellWindowPosition,
                          age: ageNum(s.players!.birthdate),
                          dpv: Number(s.dpv),
                          marketDelta:
                            marketDeltaMap.get(s.player_id) ?? null,
                        })
                      : null;
                    return (
                      <tr
                        key={s.player_id}
                        className="border-t border-zinc-100 dark:border-zinc-800"
                      >
                        <td className="px-3 py-2 font-medium">
                          <Link
                            href={`/player/${s.player_id}?fmt=${league.scoring_format}`}
                            className="hover:underline"
                          >
                            {s.players!.name}
                          </Link>
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                            {pos}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-zinc-500">
                          {s.players!.current_team ?? "—"}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {ageFrom(s.players!.birthdate)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">
                          {s.dpv}
                        </td>
                        <td className="px-3 py-2 text-zinc-500">{s.tier}</td>
                        <td className="px-3 py-2">
                          {sw ? (
                            <SellWindowBadge sw={sw} isPro={isPro} size="xs" />
                          ) : (
                            <span className="text-zinc-400">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 text-xs text-zinc-500">
            Want a trade-calculator flow against another team?{" "}
            <Link
              href={`/trade?league=${id}&from=${focusedTeam.rosterId}`}
              className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
            >
              Open trade calc with this roster loaded
            </Link>
            .
          </div>
        </div>
      )}

      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold">Free Agents</h2>
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-xs">
          {POSITIONS.map((p) => {
            const params = new URLSearchParams();
            if (teamFilter) params.set("team", teamFilter);
            if (p !== "ALL") params.set("pos", p);
            const href = `/league/${id}${
              params.toString() ? `?${params.toString()}` : ""
            }`;
            return (
              <Link
                key={p}
                href={href}
                className={`px-2.5 py-1 ${
                  posFilter === p
                    ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
                }`}
              >
                {p}
              </Link>
            );
          })}
        </div>
      </div>
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <table className="w-full text-sm min-w-[640px]">
          <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
            <tr>
              <th className="px-3 py-2 text-left">Player</th>
              <th className="px-3 py-2 text-left">Pos</th>
              <th className="px-3 py-2 text-left">Team</th>
              <th className="px-3 py-2 text-right">Age</th>
              <th className="px-3 py-2 text-right">PYV</th>
              <th className="px-3 py-2 text-left">Tier</th>
            </tr>
          </thead>
          <tbody>
            {filteredFAs.slice(0, 50).map((fa) => (
              <tr
                key={fa.player_id}
                className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
              >
                <td className="px-3 py-2 font-medium">
                  <Link
                    href={`/player/${fa.player_id}?fmt=${league.scoring_format}`}
                    className="hover:underline"
                  >
                    {fa.players!.name}
                  </Link>
                </td>
                <td className="px-3 py-2">
                  <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                    {fa.players!.position}
                  </span>
                </td>
                <td className="px-3 py-2 text-zinc-500">
                  {fa.players!.current_team ?? "—"}
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {ageFrom(fa.players!.birthdate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {fa.dpv}
                </td>
                <td className="px-3 py-2 text-zinc-500">{fa.tier}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Verdict pill — compact version of the badge on the full report page.
// `score` is null for free users (we hide the number but show the label,
// which is the upgrade pitch). Pro users see "Win-now contender · 87".
function VerdictPill({
  tone,
  label,
  score,
}: {
  tone: "elite" | "good" | "neutral" | "warn" | "bad";
  label: string;
  score: number | null;
}) {
  const cls: Record<typeof tone, string> = {
    elite:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    good: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
    neutral: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    bad: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded ${cls[tone]} whitespace-nowrap`}
    >
      <span>{label}</span>
      {score !== null && (
        <span className="font-bold tabular-nums opacity-80">{score}</span>
      )}
    </span>
  );
}
