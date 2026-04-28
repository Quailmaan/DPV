import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { getCurrentTier } from "@/lib/billing/tier";
import { createServerClient } from "@/lib/supabase/server";
import {
  computeReportCards,
  type LeaguePick,
  type Position,
  type ReportPlayer,
  type ReportCard,
  type RosterInput,
} from "@/lib/league/reportCard";

// Roster Report Card — full per-team breakdown.
//
// Pro feature. Free users see the verdict label only (composite score
// hidden), with an upgrade prompt. The teaser still adds value for
// free users (they learn whether they're a contender) while making
// the upgrade obvious.
//
// All five sub-scores normalize against the league this roster belongs
// to — a 70 here means above-median *within this league*. Decisions
// happen in your league, not in some global benchmark.

export default async function ReportCardPage({
  params,
}: {
  params: Promise<{ id: string; rosterId: string }>;
}) {
  const { id, rosterId } = await params;
  const rosterIdNum = Number(rosterId);
  if (!Number.isFinite(rosterIdNum)) return notFound();

  const session = await getCurrentSession();
  if (!session) redirect(`/login?next=/league/${id}/team/${rosterId}/report`);

  const sb = await createServerClient();

  // Auth-gate to leagues the user actually subscribed to.
  if (!session.isAdmin) {
    const { data: subscription } = await sb
      .from("user_leagues")
      .select("league_id")
      .eq("league_id", id)
      .maybeSingle();
    if (!subscription) redirect("/league");
  }

  const tierState = await getCurrentTier();
  const isPro = tierState.tier === "pro";

  // Pull league shape, all rosters, all picks, all DPV snapshots in
  // parallel — same pattern as the league detail page. We need the
  // FULL league (all rosters) because the report card normalizes
  // sub-scores within the league.
  const [leagueRes, rostersRes, picksRes] = await Promise.all([
    sb.from("leagues").select("*").eq("league_id", id).maybeSingle(),
    sb
      .from("league_rosters")
      .select("roster_id, owner_display_name, team_name, player_ids")
      .eq("league_id", id)
      .order("roster_id", { ascending: true }),
    sb
      .from("league_picks")
      .select("season, round, owner_roster_id")
      .eq("league_id", id),
  ]);

  if (!leagueRes.data) return notFound();
  const league = leagueRes.data as {
    league_id: string;
    name: string;
    scoring_format: "STANDARD" | "HALF_PPR" | "FULL_PPR";
    roster_positions: string[] | null;
    total_rosters: number | null;
  };

  const rosters = (rostersRes.data ?? []) as Array<{
    roster_id: number;
    owner_display_name: string | null;
    team_name: string | null;
    player_ids: string[];
  }>;

  // DB returns snake_case (owner_roster_id) — normalize to the camelCase
  // shape the calculator expects.
  const picks: LeaguePick[] = (
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

  const focused = rosters.find((r) => r.roster_id === rosterIdNum);
  if (!focused) return notFound();

  // Pull DPV + player metadata for every rostered player.
  const allPlayerIds = new Set<string>();
  for (const r of rosters) for (const pid of r.player_ids) allPlayerIds.add(pid);
  const { data: snaps } = await sb
    .from("dpv_snapshots")
    .select("player_id, dpv, players(name, position, birthdate)")
    .eq("scoring_format", league.scoring_format)
    .in("player_id", Array.from(allPlayerIds));

  type Snap = {
    player_id: string;
    dpv: number;
    players: { name: string; position: string; birthdate: string | null } | null;
  };
  const snapMap = new Map<string, Snap>();
  for (const s of (snaps ?? []) as unknown as Snap[]) snapMap.set(s.player_id, s);

  // Build RosterInput[] for the calculator — players + picks per roster.
  const picksByRoster = new Map<number, LeaguePick[]>();
  for (const p of picks) {
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

  const cards = computeReportCards(rosterInputs, {
    rosterPositions: league.roster_positions,
    totalRosters: league.total_rosters,
  });

  const card = cards.find((c) => c.rosterId === rosterIdNum);
  if (!card) return notFound();

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-6">
        <Link
          href={`/league/${id}`}
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← {league.name}
        </Link>
      </div>

      {/* Header — always shown, even for free users */}
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {card.ownerName}
          {card.teamName && (
            <span className="text-zinc-500 font-normal ml-2 text-base">
              ({card.teamName})
            </span>
          )}
        </h1>
        <p className="text-sm text-zinc-500 mt-1">Roster Report Card</p>
      </div>

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 mb-6">
        <div className="flex items-center gap-4 flex-wrap">
          {isPro ? (
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-bold tabular-nums">
                {card.composite}
              </span>
              <span className="text-zinc-500 text-sm">/ 100</span>
            </div>
          ) : (
            <div className="flex items-baseline gap-2">
              <span className="text-5xl font-bold tabular-nums text-zinc-300 dark:text-zinc-700 select-none">
                ••
              </span>
              <span className="text-zinc-400 text-sm">/ 100</span>
            </div>
          )}
          <VerdictBadge tone={card.tone} label={card.verdict} />
        </div>
      </div>

      {/* Pro gate — full breakdown */}
      {isPro ? (
        <ProBreakdown card={card} />
      ) : (
        <FreeTeaser leagueId={id} />
      )}
    </div>
  );
}

function ProBreakdown({ card }: { card: ReportCard }) {
  return (
    <>
      <h2 className="text-sm font-semibold mb-3">Sub-scores</h2>
      <div className="space-y-3 mb-8">
        <SubScoreRow
          label="Production"
          weight="30%"
          score={card.subScores.production.score}
          reason={card.subScores.production.reason}
        />
        <SubScoreRow
          label="Window"
          weight="25%"
          score={card.subScores.window.score}
          reason={card.subScores.window.reason}
        />
        <SubScoreRow
          label="Age Profile"
          weight="20%"
          score={card.subScores.age.score}
          reason={card.subScores.age.reason}
        />
        <SubScoreRow
          label="Depth Risk"
          weight="15%"
          score={card.subScores.depth.score}
          reason={card.subScores.depth.reason}
        />
        <SubScoreRow
          label="Cap Health"
          weight="10%"
          score={card.subScores.cap.score}
          reason={card.subScores.cap.reason}
        />
      </div>

      <h2 className="text-sm font-semibold mb-3">Do this next</h2>
      <ol className="space-y-2 mb-8">
        {card.actions.map((a, i) => (
          <li
            key={i}
            className="flex gap-3 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3 text-sm"
          >
            <span className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400 text-xs font-semibold flex items-center justify-center">
              {i + 1}
            </span>
            <span>{a}</span>
          </li>
        ))}
      </ol>

      <details className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950 p-4 text-xs text-zinc-600 dark:text-zinc-400">
        <summary className="cursor-pointer font-semibold text-zinc-700 dark:text-zinc-300">
          How is this calculated?
        </summary>
        <div className="mt-3 space-y-2">
          <p>
            Composite is a weighted blend of five sub-scores, each
            normalized 0-100 within your league. A 70 means
            above-median in *this* league — decisions happen in your
            context, not against a global benchmark.
          </p>
          <p>
            <strong>Production</strong> is starter-weighted DPV (bench
            counted at 25%). <strong>Window</strong> applies position-
            specific aging curves (RBs cliff at 27, WRs at 30, TEs at
            31, QBs at 35) to project how much value holds across the
            next two seasons. <strong>Age Profile</strong> scores
            average starter age against an ideal curve (peak 24-28).{" "}
            <strong>Depth Risk</strong> is the average % drop if your
            starter at each position got hurt. <strong>Cap Health</strong>{" "}
            sums future pick values with year discount (Y+1 full, Y+2
            70%, Y+3 50%).
          </p>
        </div>
      </details>
    </>
  );
}

function FreeTeaser({ leagueId }: { leagueId: string }) {
  return (
    <div className="rounded-lg border-2 border-emerald-300 dark:border-emerald-800 bg-emerald-50/40 dark:bg-emerald-950/30 p-6">
      <h2 className="text-lg font-semibold mb-2">Unlock the full report</h2>
      <p className="text-sm text-zinc-700 dark:text-zinc-300 mb-4">
        See your composite score, five sub-scores (Production, Window,
        Age Profile, Depth Risk, Cap Health) with reasoning, and three
        recommended next moves tailored to your roster.
      </p>
      <ul className="text-sm space-y-1.5 mb-5 text-zinc-600 dark:text-zinc-400">
        <li>· Composite 0-100 with a verdict</li>
        <li>· Five sub-scores with explanations</li>
        <li>· 3 recommended actions (sell-X, target-Y, etc.)</li>
        <li>· Updates after every re-sync</li>
      </ul>
      <div className="flex gap-3 flex-wrap">
        <Link
          href="/pricing"
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 transition-colors"
        >
          Upgrade to Pro
        </Link>
        <Link
          href={`/league/${leagueId}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm font-medium px-4 py-2 transition-colors"
        >
          Back to league
        </Link>
      </div>
    </div>
  );
}

function VerdictBadge({ tone, label }: { tone: ReportCard["tone"]; label: string }) {
  const cls: Record<ReportCard["tone"], string> = {
    elite:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900",
    good:
      "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300 border-sky-200 dark:border-sky-900",
    neutral:
      "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300 border-zinc-200 dark:border-zinc-700",
    warn:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-200 dark:border-amber-900",
    bad:
      "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300 border-red-200 dark:border-red-900",
  };
  return (
    <span
      className={`text-sm font-semibold px-3 py-1 rounded-full border ${cls[tone]}`}
    >
      {label}
    </span>
  );
}

function SubScoreRow({
  label,
  weight,
  score,
  reason,
}: {
  label: string;
  weight: string;
  score: number;
  reason: string;
}) {
  // Bar color rolls hot→cold by score band so the eye picks up the
  // weak spots without reading numbers.
  const barColor =
    score >= 75
      ? "bg-emerald-500"
      : score >= 50
        ? "bg-sky-500"
        : score >= 25
          ? "bg-amber-500"
          : "bg-red-500";

  return (
    <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-3">
      <div className="flex items-center justify-between gap-3 mb-1.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="font-semibold text-sm">{label}</span>
          <span className="text-[11px] text-zinc-400">{weight}</span>
        </div>
        <span className="text-sm font-bold tabular-nums">{score}</span>
      </div>
      <div className="h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden mb-2">
        <div
          className={`h-full ${barColor}`}
          style={{ width: `${score}%` }}
        />
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400">{reason}</p>
    </div>
  );
}
