import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { readSubscriptionState } from "@/lib/billing/tier";
import { createServerClient } from "@/lib/supabase/server";
import RemoveLeagueButton from "./RemoveLeagueButton";
import ResyncLeagueButton from "./ResyncLeagueButton";
import SyncLeagueForm from "./SyncLeagueForm";

// Free tier ceiling. Pro is uncapped — both this page and the
// syncLeagueAction read the user's tier and gate accordingly. The DB
// trigger (enforce_user_league_cap) is the hard guarantee.
const FREE_LEAGUE_CAP = 1;

export default async function LeaguesPage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login?next=/league");

  const sb = await createServerClient();
  const tierState = await readSubscriptionState(sb, session.userId);
  const isPro = tierState.tier === "pro";

  // user_leagues + leagues join. RLS on user_leagues already filters by
  // auth.uid() so this only returns the signed-in user's subscriptions.
  const { data: rows } = await sb
    .from("user_leagues")
    .select(
      "league_id, added_at, leagues:league_id (name, season, total_rosters, scoring_format, synced_at)",
    )
    .order("added_at", { ascending: false });

  type LeagueShape = {
    name: string;
    season: string | null;
    total_rosters: number | null;
    scoring_format: string | null;
    synced_at: string;
  };

  const leagues = (rows ?? []).map((r) => {
    // The Supabase types for nested selects can come back as either an
    // object or an array of one — normalize.
    const raw = r.leagues as unknown as LeagueShape | LeagueShape[] | null;
    const league: LeagueShape | null = Array.isArray(raw)
      ? (raw[0] ?? null)
      : raw;
    return {
      league_id: r.league_id,
      added_at: r.added_at,
      name: league?.name ?? "(unknown)",
      season: league?.season ?? null,
      total_rosters: league?.total_rosters ?? null,
      scoring_format: league?.scoring_format ?? null,
      synced_at: league?.synced_at ?? r.added_at,
    };
  });

  // Pro users are uncapped, so atCap stays false regardless of count.
  const atCap = !isPro && leagues.length >= FREE_LEAGUE_CAP;

  // Relative time formatter for the "Last Sync" column. Same-day formats
  // ("just now", "5 mins ago") so users see immediate feedback after
  // hitting Re-sync — the previous toLocaleDateString call only changed
  // when the calendar day rolled over.
  function formatRelative(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) return "just now";
    const sec = Math.floor(ms / 1000);
    if (sec < 30) return "just now";
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} min${min === 1 ? "" : "s"} ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} hr${hr === 1 ? "" : "s"} ago`;
    const day = Math.floor(hr / 24);
    if (day < 7) return `${day} day${day === 1 ? "" : "s"} ago`;
    return new Date(iso).toLocaleDateString();
  }

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Your leagues</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Sync a Sleeper league to view rosters, free agents, and
            roster-aware trade suggestions.
          </p>
        </div>
        <div className="text-xs text-zinc-500">
          {isPro
            ? `${leagues.length} leagues · Pro (unlimited)`
            : `${leagues.length} / ${FREE_LEAGUE_CAP} leagues · Free`}
        </div>
      </div>

      {atCap ? (
        <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm text-amber-900 dark:text-amber-200 mb-8">
          Free accounts are limited to {FREE_LEAGUE_CAP} league.{" "}
          <Link
            href="/pricing"
            className="font-medium underline hover:no-underline"
          >
            Upgrade to Pro
          </Link>{" "}
          for unlimited leagues, or remove your current league below to swap
          in another.
        </div>
      ) : (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-8">
          <h2 className="text-sm font-semibold mb-3">Sync a Sleeper league</h2>
          <SyncLeagueForm />
          <div className="text-xs text-zinc-500 mt-3">
            Find your league ID in the Sleeper app URL: sleeper.com/leagues/
            <span className="font-mono">1234567890</span>/...
          </div>
        </div>
      )}

      <h2 className="text-sm font-semibold mb-3">Synced leagues</h2>
      {leagues.length === 0 ? (
        <div className="text-sm text-zinc-500">No leagues synced yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm min-w-[640px]">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left">League</th>
                <th className="px-4 py-2 text-left">Season</th>
                <th className="px-4 py-2 text-left">Format</th>
                <th className="px-4 py-2 text-right">Teams</th>
                <th className="px-4 py-2 text-right">Last Sync</th>
                <th className="px-4 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {leagues.map((l) => (
                <tr
                  key={l.league_id}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <td className="px-4 py-2 font-medium">
                    <Link
                      href={`/league/${l.league_id}`}
                      className="hover:underline"
                    >
                      {l.name}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-zinc-500">{l.season}</td>
                  <td className="px-4 py-2 text-zinc-500">
                    {l.scoring_format}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {l.total_rosters}
                  </td>
                  <td
                    className="px-4 py-2 text-right text-zinc-500 tabular-nums"
                    title={new Date(l.synced_at).toLocaleString()}
                  >
                    {formatRelative(l.synced_at)}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <ResyncLeagueButton leagueId={l.league_id} />
                      <RemoveLeagueButton leagueId={l.league_id} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
