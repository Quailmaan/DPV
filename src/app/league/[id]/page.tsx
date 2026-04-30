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
  type SellWindow,
} from "@/lib/dpv/sellWindow";
import SellWindowBadge from "@/components/SellWindowBadge";
import {
  findTrades,
  type TradeFinderTeam,
  type TradeFinderPlayer,
  type TradePosition,
} from "@/lib/league/tradeFinder";
import MyTeamPicker from "./MyTeamPicker";

type SearchParams = Promise<{
  team?: string;
  pos?: string;
  pick?: string;
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
  const explicitTeamFilter = sp.team ?? "";
  const showPickBanner = sp.pick === "1";
  const posFilter = (sp.pos ?? "ALL").toUpperCase();

  const session = await getCurrentSession();
  if (!session) redirect(`/login?next=/league/${id}`);

  const sb = await createServerClient();
  // Auth-gate + read the user's persisted roster_id for this league. RLS
  // on user_leagues prevents leakage, so a missing row means "not yours."
  // Admin users can view any league for support / debugging.
  let persistedRosterId: number | null = null;
  if (!session.isAdmin) {
    const { data: subscription } = await sb
      .from("user_leagues")
      .select("league_id, roster_id")
      .eq("league_id", id)
      .maybeSingle();
    if (!subscription) redirect("/league");
    persistedRosterId =
      (subscription.roster_id as number | null | undefined) ?? null;
  } else {
    // Admin viewing the league: still try to load their own row so if
    // they happen to subscribe themselves, the focus default works.
    const { data: subscription } = await sb
      .from("user_leagues")
      .select("roster_id")
      .eq("league_id", id)
      .maybeSingle();
    persistedRosterId =
      (subscription?.roster_id as number | null | undefined) ?? null;
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

  // Scale FantasyCalc market values to the DPV magnitude so the trade
  // finder can blend them with PYV directly. We compute a single global
  // scale factor — sum of DPVs over the intersection / sum of markets
  // over the intersection — and apply it to every market value. A
  // global linear scale keeps cross-position comparability (PYV is
  // already cross-position-comparable; this just brings market onto
  // the same scale).
  const scaledMarketByPid = new Map<string, number>();
  {
    let dpvSum = 0;
    let mktSum = 0;
    for (const s of marketDeltaInput) {
      if (s.market === null) continue;
      dpvSum += s.dpv;
      mktSum += s.market;
    }
    const k = mktSum > 0 ? dpvSum / mktSum : 1;
    for (const [pid, mv] of marketByPid.entries()) {
      scaledMarketByPid.set(pid, mv * k);
    }
  }

  // Sell-window per rostered player. Computed once, reused by the
  // focused-team table column AND the trade finder. Rostered-only —
  // there's no point computing for free agents here (the FA list
  // doesn't show a window column today).
  const sellWindowByPlayer = new Map<string, SellWindow | null>();
  for (const r of rosters) {
    for (const pid of r.player_ids) {
      if (sellWindowByPlayer.has(pid)) continue;
      const s = snapMap.get(pid);
      if (!s || !s.players) {
        sellWindowByPlayer.set(pid, null);
        continue;
      }
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") {
        sellWindowByPlayer.set(pid, null);
        continue;
      }
      const bd = s.players.birthdate;
      const ageYears = bd
        ? (Date.now() - new Date(bd).getTime()) /
          (365.25 * 24 * 3600 * 1000)
        : null;
      sellWindowByPlayer.set(
        pid,
        computeSellWindow({
          position: pos as SellWindowPosition,
          age: ageYears,
          dpv: Number(s.dpv),
          marketDelta: marketDeltaMap.get(pid) ?? null,
        }),
      );
    }
  }

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

  // Resolve which team the page focuses on. Priority order:
  //   1. ?team=<rosterId> in the URL (explicit override — admin/exploring)
  //   2. user_leagues.roster_id (persisted "my team" pick)
  //   3. nothing (renders the unfocused power-rankings view)
  const teamFilter =
    explicitTeamFilter ||
    (persistedRosterId !== null ? String(persistedRosterId) : "");
  const focusedTeam = teamFilter
    ? summaries.find(
        (s) => s.rosterId.toString() === teamFilter || s.ownerName === teamFilter,
      )
    : null;
  const focusedRoster = focusedTeam
    ? rosters.find((r) => r.roster_id === focusedTeam.rosterId) ?? null
    : null;

  // Approximate NFL years played from birthdate. We don't have a
  // seasons-played column on the page query and querying player_seasons
  // for every rostered player would be heavyweight; an age-based proxy
  // is good enough because the blend weight only needs to roughly
  // reflect "rookie / sophomore / vet" anyway. QBs typically enter at
  // 23, skill players at 22 — that offset is the only positional split.
  function approxYearsPro(
    birthdate: string | null,
    position: TradePosition,
  ): number {
    if (!birthdate) return 3;
    const age =
      (Date.now() - new Date(birthdate).getTime()) /
      (365.25 * 24 * 3600 * 1000);
    const baseAge = position === "QB" ? 23 : 22;
    return Math.max(0, Math.floor(age - baseAge));
  }
  function ageInYears(birthdate: string | null): number | null {
    if (!birthdate) return null;
    return (
      (Date.now() - new Date(birthdate).getTime()) /
      (365.25 * 24 * 3600 * 1000)
    );
  }

  // Trade finder — build TradeFinderTeam shape per roster from data
  // we already have, then ask the pure helper for top ideas. Computed
  // only when a team is focused (it's the entry point to the section).
  function buildTradeFinderTeam(
    rosterId: number,
    ownerName: string,
    teamName: string | null,
    playerIds: string[],
    byPos: Record<TradePosition, number>,
  ): TradeFinderTeam {
    const players: TradeFinderPlayer[] = [];
    for (const pid of playerIds) {
      const s = snapMap.get(pid);
      if (!s || !s.players) continue;
      const pos = s.players.position;
      if (pos !== "QB" && pos !== "RB" && pos !== "WR" && pos !== "TE") continue;
      const tp = pos as TradePosition;
      players.push({
        playerId: pid,
        name: s.players.name,
        position: tp,
        dpv: Number(s.dpv),
        marketValue: scaledMarketByPid.get(pid) ?? null,
        yearsPro: approxYearsPro(s.players.birthdate, tp),
        age: ageInYears(s.players.birthdate),
        sellWindow: sellWindowByPlayer.get(pid) ?? null,
      });
    }
    return { rosterId, ownerName, teamName, players, byPos };
  }
  const tradeIdeas = focusedTeam && focusedRoster
    ? findTrades(
        buildTradeFinderTeam(
          focusedTeam.rosterId,
          focusedTeam.ownerName,
          focusedTeam.teamName,
          focusedRoster.player_ids,
          focusedTeam.byPos,
        ),
        rosters
          .filter((r) => r.roster_id !== focusedTeam.rosterId)
          .map((r) => {
            const summary = summaries.find((s) => s.rosterId === r.roster_id);
            return buildTradeFinderTeam(
              r.roster_id,
              r.owner_display_name ?? `Team ${r.roster_id}`,
              r.team_name,
              r.player_ids,
              summary?.byPos ?? { QB: 0, RB: 0, WR: 0, TE: 0 },
            );
          }),
        leaguePosAvg,
      )
    : [];

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
        <MyTeamPicker
          leagueId={id}
          currentRosterId={persistedRosterId}
          rosters={summaries.map((s) => ({
            rosterId: s.rosterId,
            ownerName: s.ownerName,
            teamName: s.teamName,
          }))}
          banner={false}
        />
      </div>

      {(persistedRosterId === null || showPickBanner) && (
        <MyTeamPicker
          leagueId={id}
          currentRosterId={persistedRosterId}
          rosters={summaries.map((s) => ({
            rosterId: s.rosterId,
            ownerName: s.ownerName,
            teamName: s.teamName,
          }))}
          banner
        />
      )}

      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Power Rankings</h2>
        {isPro && <CsvLink href={`/api/league/${id}/export/rankings`} />}
      </div>
      {/* Power rankings: # / Team / Total / Verdict are essentials at
          every width. Per-position strengths come back at sm; Top Player
          column at lg. The Report → link is always visible. */}
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 mb-8">
        <table className="w-full text-sm lg:min-w-[680px]">
          <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
            <tr>
              <th className="px-3 py-2 text-left w-10">#</th>
              <th className="px-3 py-2 text-left">Team</th>
              <th className="px-3 py-2 text-right">Total PYV</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right">QB</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right">RB</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right">WR</th>
              <th className="hidden sm:table-cell px-3 py-2 text-right">TE</th>
              <th className="hidden lg:table-cell px-3 py-2 text-left">Top Player</th>
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
                    className={`hidden sm:table-cell px-3 py-2 text-right tabular-nums ${cls}`}
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
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-800/50 active:bg-zinc-100 dark:active:bg-zinc-800"
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
                  <td className="hidden lg:table-cell px-3 py-2 text-zinc-500">
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
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-semibold">
              {focusedTeam.ownerName} — Roster
            </h2>
            {isPro && (
              <CsvLink
                href={`/api/league/${id}/export/team/${focusedTeam.rosterId}`}
              />
            )}
          </div>
          {/* Focused-team roster: Player + PYV are essentials. Pos comes
              back at sm; Age + Window at md; Team + Tier at lg. */}
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm lg:min-w-[640px]">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-3 py-2 text-left">Player</th>
                  <th className="hidden sm:table-cell px-3 py-2 text-left">Pos</th>
                  <th className="hidden lg:table-cell px-3 py-2 text-left">Team</th>
                  <th className="hidden md:table-cell px-3 py-2 text-right">Age</th>
                  <th className="px-3 py-2 text-right">PYV</th>
                  <th className="hidden lg:table-cell px-3 py-2 text-left">Tier</th>
                  <th className="hidden md:table-cell px-3 py-2 text-left">Window</th>
                </tr>
              </thead>
              <tbody>
                {focusedRoster.player_ids
                  .map((pid) => snapMap.get(pid))
                  .filter((s): s is Snap => !!s && !!s.players)
                  .sort((a, b) => b.dpv - a.dpv)
                  .map((s) => {
                    const pos = s.players!.position;
                    const sw = sellWindowByPlayer.get(s.player_id) ?? null;
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
                          {/* Phone-only summary line — Pos + Team + Tier
                              are hidden columns at this width. */}
                          <div className="sm:hidden text-xs text-zinc-500 mt-0.5">
                            {[pos, s.players!.current_team, s.tier]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        </td>
                        <td className="hidden sm:table-cell px-3 py-2">
                          <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                            {pos}
                          </span>
                        </td>
                        <td className="hidden lg:table-cell px-3 py-2 text-zinc-500">
                          {s.players!.current_team ?? "—"}
                        </td>
                        <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums">
                          {ageFrom(s.players!.birthdate)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">
                          {s.dpv}
                        </td>
                        <td className="hidden lg:table-cell px-3 py-2 text-zinc-500">{s.tier}</td>
                        <td className="hidden md:table-cell px-3 py-2">
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

          <div className="mt-8">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold">Trade Ideas</h2>
              <span className="text-xs text-zinc-500">
                Sells × needs across your league
              </span>
            </div>
            {!isPro ? (
              <TradeIdeasTeaser leagueId={id} />
            ) : tradeIdeas.length === 0 ? (
              <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 text-sm text-zinc-500">
                No clear trade ideas right now — your sell-window flags
                don&apos;t line up with another team&apos;s positional
                surplus. Re-check after the next sync.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {tradeIdeas.map((idea) => (
                  <TradeIdeaCard
                    key={`${idea.give.playerId}-${idea.receive.playerId}`}
                    leagueId={id}
                    fromRosterId={focusedTeam.rosterId}
                    idea={idea}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mb-4 flex items-baseline justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-sm font-semibold">Free Agents</h2>
          {isPro && <CsvLink href={`/api/league/${id}/export/free-agents`} />}
        </div>
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
      {/* Free agents table — same column priority as the team roster. */}
      <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <table className="w-full text-sm lg:min-w-[640px]">
          <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
            <tr>
              <th className="px-3 py-2 text-left">Player</th>
              <th className="hidden sm:table-cell px-3 py-2 text-left">Pos</th>
              <th className="hidden lg:table-cell px-3 py-2 text-left">Team</th>
              <th className="hidden md:table-cell px-3 py-2 text-right">Age</th>
              <th className="px-3 py-2 text-right">PYV</th>
              <th className="hidden sm:table-cell px-3 py-2 text-left">Tier</th>
            </tr>
          </thead>
          <tbody>
            {filteredFAs.slice(0, 50).map((fa) => (
              <tr
                key={fa.player_id}
                className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 active:bg-zinc-100 dark:active:bg-zinc-800"
              >
                <td className="px-3 py-2 font-medium">
                  <Link
                    href={`/player/${fa.player_id}?fmt=${league.scoring_format}`}
                    className="hover:underline"
                  >
                    {fa.players!.name}
                  </Link>
                  <div className="sm:hidden text-xs text-zinc-500 mt-0.5">
                    {[
                      fa.players!.position,
                      fa.players!.current_team,
                      fa.tier,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                </td>
                <td className="hidden sm:table-cell px-3 py-2">
                  <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                    {fa.players!.position}
                  </span>
                </td>
                <td className="hidden lg:table-cell px-3 py-2 text-zinc-500">
                  {fa.players!.current_team ?? "—"}
                </td>
                <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums">
                  {ageFrom(fa.players!.birthdate)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">
                  {fa.dpv}
                </td>
                <td className="hidden sm:table-cell px-3 py-2 text-zinc-500">{fa.tier}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// One trade idea — `give → receive (+ extras)` with rationale and a
// quick link to the trade calculator pre-loaded with both sides. The
// market alignment tag tells the user whether FantasyCalc backs the
// PYV-suggested trade. When market initially disagreed, the trade
// finder either added a sweetener (rendered as "+ Player" beneath
// the receive anchor) or dropped the trade — disagree-without-fix
// shouldn't surface at all.
function TradeIdeaCard({
  leagueId,
  fromRosterId,
  idea,
}: {
  leagueId: string;
  fromRosterId: number;
  idea: {
    give: { playerId: string; name: string; position: string; dpv: number };
    receive: {
      playerId: string;
      name: string;
      position: string;
      dpv: number;
    };
    receiveExtras: Array<{
      playerId: string;
      name: string;
      position: string;
      dpv: number;
    }>;
    partnerRosterId: number;
    partnerName: string;
    partnerTeamName: string | null;
    myDpvDelta: number;
    marketAlignment: "ok" | "disagree" | "none";
    rationale: string;
  };
}) {
  const deltaLabel =
    idea.myDpvDelta > 0
      ? `+${Math.round(idea.myDpvDelta)}`
      : Math.round(idea.myDpvDelta).toString();
  const deltaCls =
    idea.myDpvDelta > 0
      ? "text-emerald-700 dark:text-emerald-400"
      : idea.myDpvDelta < 0
      ? "text-amber-700 dark:text-amber-400"
      : "text-zinc-500";
  // Deep-link the trade calc with every asset pre-staged. The calc
  // honors `from` / `to` / `give` / `receive` and accepts a
  // comma-separated `receive` list, so 1-for-2s land fully loaded.
  const receiveIds = [
    idea.receive.playerId,
    ...idea.receiveExtras.map((p) => p.playerId),
  ].join(",");
  const tradeHref =
    `/trade?league=${leagueId}` +
    `&from=${fromRosterId}` +
    `&to=${idea.partnerRosterId}` +
    `&give=${encodeURIComponent(idea.give.playerId)}` +
    `&receive=${encodeURIComponent(receiveIds)}`;
  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4">
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <div className="text-xs uppercase tracking-wider text-zinc-500 truncate">
          With {idea.partnerName}
          {idea.partnerTeamName ? ` (${idea.partnerTeamName})` : ""}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <MarketAlignmentTag alignment={idea.marketAlignment} />
          <div className={`text-xs font-medium tabular-nums ${deltaCls}`}>
            PYV {deltaLabel}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-start mb-2">
        <div>
          <div className="text-[11px] uppercase text-zinc-500">Give</div>
          <div className="font-medium leading-tight">{idea.give.name}</div>
          <div className="text-xs text-zinc-500 tabular-nums">
            {idea.give.position} · {idea.give.dpv}
          </div>
        </div>
        <div className="text-zinc-400 mt-3">→</div>
        <div>
          <div className="text-[11px] uppercase text-zinc-500">Receive</div>
          <div className="font-medium leading-tight">{idea.receive.name}</div>
          <div className="text-xs text-zinc-500 tabular-nums">
            {idea.receive.position} · {idea.receive.dpv}
          </div>
          {idea.receiveExtras.map((p) => (
            <div key={p.playerId} className="mt-1 pt-1 border-t border-zinc-100 dark:border-zinc-800">
              <div className="text-[11px] uppercase text-zinc-500">+ Sweetener</div>
              <div className="font-medium leading-tight text-sm">{p.name}</div>
              <div className="text-xs text-zinc-500 tabular-nums">
                {p.position} · {p.dpv}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="text-xs text-zinc-600 dark:text-zinc-400 mb-3">
        {idea.rationale}
      </div>
      <Link
        href={tradeHref}
        className="text-xs text-emerald-700 dark:text-emerald-400 hover:underline"
      >
        Open in trade calc →
      </Link>
    </div>
  );
}

// Compact tag showing whether FantasyCalc market view backs the trade.
//   ok       → green "Market ✓"     — both signals agree, high confidence
//   disagree → amber "Market disagrees" — PYV says fair, market says no;
//              user should expect the counterparty to push back
//   none     → zinc  "PYV-only"     — at least one player has no market
//              data (typically rookies pre-FantasyCalc-coverage)
function MarketAlignmentTag({
  alignment,
}: {
  alignment: "ok" | "disagree" | "none";
}) {
  const cfg: Record<typeof alignment, { label: string; cls: string }> = {
    ok: {
      label: "Market ✓",
      cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
    },
    disagree: {
      label: "Market disagrees",
      cls: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
    },
    none: {
      label: "PYV-only",
      cls: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
    },
  };
  const c = cfg[alignment];
  return (
    <span
      className={`inline-block text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${c.cls}`}
    >
      {c.label}
    </span>
  );
}

// Free-tier teaser. Shows the section is live without giving away the
// actual ideas — the upgrade pitch is the only thing visible.
function TradeIdeasTeaser({ leagueId }: { leagueId: string }) {
  return (
    <div className="rounded-md border border-emerald-200/60 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/20 p-4 text-sm">
      <div className="font-medium text-emerald-900 dark:text-emerald-200 mb-1">
        Pro: see 5 fair-value trade ideas tailored to this roster.
      </div>
      <div className="text-xs text-emerald-800/80 dark:text-emerald-300/80 mb-3">
        We pair your sell-window flags with each opponent&apos;s
        positional surplus and hand you the trades that make sense for
        both sides.
      </div>
      <Link
        href={`/pricing?return=/league/${leagueId}`}
        className="inline-block text-xs font-medium px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white"
      >
        Upgrade to Pro
      </Link>
    </div>
  );
}

// Compact "Download CSV" link next to a section heading. Pro-only —
// the page gates rendering, so this just renders the visual without
// re-checking. A plain anchor (not next/link) so the browser handles
// the download attribute and Content-Disposition correctly.
function CsvLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-emerald-700 dark:hover:text-emerald-400"
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
      Download CSV
    </a>
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
