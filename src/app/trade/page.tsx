import { createServerClient } from "@/lib/supabase/server";
import type { ScoringFormat } from "@/lib/dpv/types";
import TradeCalculator, {
  type TradePlayer,
  type LeagueRosterOption,
} from "./TradeCalculator";

type SearchParams = Promise<{
  fmt?: string;
  league?: string;
  from?: string;
}>;

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

export default async function TradePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const requestedLeague = sp.league ?? null;
  const fromRosterId = sp.from ?? null;

  const sb = createServerClient();

  let fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";
  let leagueName: string | null = null;
  let rosterOptions: LeagueRosterOption[] = [];

  if (requestedLeague) {
    const [leagueRes, rostersRes] = await Promise.all([
      sb.from("leagues").select("*").eq("league_id", requestedLeague).maybeSingle(),
      sb
        .from("league_rosters")
        .select(
          "roster_id, owner_display_name, team_name, player_ids",
        )
        .eq("league_id", requestedLeague)
        .order("roster_id", { ascending: true }),
    ]);
    if (leagueRes.data) {
      leagueName = leagueRes.data.name;
      // League format overrides search param so trade uses the right scoring.
      if (isScoringFormat(leagueRes.data.scoring_format)) {
        fmt = leagueRes.data.scoring_format;
      }
    }
    rosterOptions = ((rostersRes.data ?? []) as Array<{
      roster_id: number;
      owner_display_name: string | null;
      team_name: string | null;
      player_ids: string[];
    }>).map((r) => ({
      rosterId: r.roster_id,
      ownerName: r.owner_display_name ?? `Team ${r.roster_id}`,
      teamName: r.team_name,
      playerIds: r.player_ids,
    }));
  }

  const { data } = await sb
    .from("dpv_snapshots")
    .select(
      "dpv, tier, player_id, players(name, position, current_team, birthdate)",
    )
    .eq("scoring_format", fmt)
    .order("dpv", { ascending: false });

  const now = Date.now();
  const players: TradePlayer[] = (data ?? [])
    .filter((r) => r.players)
    .map((r) => {
      const p = r.players as unknown as {
        name: string;
        position: string;
        current_team: string | null;
        birthdate: string | null;
      };
      const age = p.birthdate
        ? (now - new Date(p.birthdate).getTime()) /
          (365.25 * 24 * 3600 * 1000)
        : null;
      return {
        id: r.player_id,
        name: p.name,
        position: p.position,
        team: p.current_team ?? null,
        age: age !== null ? Number(age.toFixed(1)) : null,
        dpv: r.dpv,
        tier: r.tier,
      };
    });

  const fromId = fromRosterId ? Number(fromRosterId) : null;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          Trade Calculator
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Add players to each side and get a verdict based on DPV totals,
          scarcity, and age profile.
          {leagueName && (
            <span className="ml-1 text-zinc-400">
              · League:{" "}
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {leagueName}
              </span>
            </span>
          )}
        </p>
      </div>
      <TradeCalculator
        players={players}
        fmt={fmt}
        leagueId={requestedLeague}
        rosterOptions={rosterOptions}
        defaultFromRosterId={fromId && Number.isFinite(fromId) ? fromId : null}
      />
    </div>
  );
}
