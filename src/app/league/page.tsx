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
      "league_id, added_at, roster_id, leagues:league_id (name, season, total_rosters, scoring_format, synced_at)",
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
      roster_id: (r.roster_id as number | null | undefined) ?? null,
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

  // First-run pull: a hero "get started" panel that lists what unlocks
  // once a league is synced. Once they have at least one league we
  // collapse this to a compact sync form above the synced-leagues table.
  const firstRun = leagues.length === 0;

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

      {firstRun ? (
        <FirstRunHero />
      ) : atCap ? (
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
          <SleeperIdHelp />
        </div>
      )}

      {!firstRun && (
        <>
          <h2 className="text-sm font-semibold mb-3">Synced leagues</h2>
          <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm md:min-w-[640px]">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left">League</th>
                <th className="hidden sm:table-cell px-4 py-2 text-left">Season</th>
                <th className="hidden md:table-cell px-4 py-2 text-left">Format</th>
                <th className="hidden md:table-cell px-4 py-2 text-right">Teams</th>
                <th className="hidden sm:table-cell px-4 py-2 text-right">Last Sync</th>
                <th className="px-4 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {leagues.map((l) => (
                <tr
                  key={l.league_id}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 active:bg-zinc-100 dark:active:bg-zinc-800"
                >
                  <td className="px-4 py-2 font-medium">
                    <Link
                      href={`/league/${l.league_id}`}
                      className="hover:underline"
                    >
                      {l.name}
                    </Link>
                    {l.roster_id === null && (
                      <Link
                        href={`/league/${l.league_id}?pick=1`}
                        className="ml-2 text-[11px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200 active:bg-emerald-300 dark:bg-emerald-950/60 dark:text-emerald-300 dark:hover:bg-emerald-900/60 dark:active:bg-emerald-900/80"
                      >
                        Pick team
                      </Link>
                    )}
                    {/* Phone-only summary line: format · season · last sync.
                        These columns are hidden at this width. */}
                    <div className="sm:hidden text-xs text-zinc-500 mt-0.5">
                      {[
                        l.scoring_format,
                        String(l.season),
                        `${l.total_rosters}-team`,
                        formatRelative(l.synced_at),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </td>
                  <td className="hidden sm:table-cell px-4 py-2 text-zinc-500">{l.season}</td>
                  <td className="hidden md:table-cell px-4 py-2 text-zinc-500">
                    {l.scoring_format}
                  </td>
                  <td className="hidden md:table-cell px-4 py-2 text-right tabular-nums">
                    {l.total_rosters}
                  </td>
                  <td
                    className="hidden sm:table-cell px-4 py-2 text-right text-zinc-500 tabular-nums"
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
        </>
      )}
    </div>
  );
}

// First-run hero — shown only when the user has zero synced leagues.
// Functions as the empty state: spells out what unlocks once they sync,
// inlines the form, and explains where to find the league ID. The
// "synced leagues" table is hidden in this state since there's nothing
// to show.
function FirstRunHero() {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 mb-8">
      <h2 className="text-lg font-semibold tracking-tight mb-1">
        Sync your first Sleeper league
      </h2>
      <p className="text-sm text-zinc-500 mb-5">
        Takes ~10 seconds. We pull rosters, traded picks, and league
        scoring — nothing private, just what Sleeper exposes publicly.
      </p>
      <ul className="text-sm space-y-2 mb-5">
        <Unlock>
          <strong>Power rankings</strong> across every team, with QB/RB/WR/TE
          strength flags
        </Unlock>
        <Unlock>
          <strong>Roster report card</strong> per team — contender vs.
          rebuild verdict
        </Unlock>
        <Unlock>
          <strong>Sell-window flags</strong> on every player — sell now,
          sell soon, peak hold, buy
        </Unlock>
        <Unlock>
          <strong>Trade ideas</strong> tailored to your team&apos;s sells
          and your opponents&apos; needs
        </Unlock>
        <Unlock>
          League-aware <strong>trade calculator</strong> with traded picks
          + per-league position scarcity
        </Unlock>
      </ul>
      <SyncLeagueForm />
      <SleeperIdHelp />
    </div>
  );
}

function Unlock({ children }: { children: React.ReactNode }) {
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

// Step-by-step for finding the Sleeper league ID. Same copy in both
// the first-run hero and the "add another league" form so the answer
// is in front of the user wherever they're looking for it.
function SleeperIdHelp() {
  return (
    <details className="mt-3 text-xs text-zinc-500">
      <summary className="cursor-pointer hover:text-zinc-700 dark:hover:text-zinc-300">
        Where do I find my Sleeper league ID?
      </summary>
      <div className="mt-2 pl-4 space-y-1.5 text-zinc-600 dark:text-zinc-400">
        <div>
          1. Open Sleeper in a browser at{" "}
          <a
            href="https://sleeper.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
          >
            sleeper.com
          </a>{" "}
          and sign in.
        </div>
        <div>2. Navigate to the league you want to sync.</div>
        <div>
          3. Copy the long number from the URL: sleeper.com/leagues/
          <span className="font-mono text-zinc-900 dark:text-zinc-100">
            1234567890123456
          </span>
          /...
        </div>
        <div className="pt-1">
          That number is your league ID. Paste it above.
        </div>
      </div>
    </details>
  );
}
