import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import SyncLeagueForm from "./SyncLeagueForm";

export default async function LeaguesPage() {
  const sb = createServerClient();
  const { data } = await sb
    .from("leagues")
    .select("league_id, name, season, total_rosters, scoring_format, synced_at")
    .order("synced_at", { ascending: false });

  const leagues = data ?? [];

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Leagues</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Sync a Sleeper league to view rosters, free agents, and roster-aware
          trade suggestions.
        </p>
      </div>

      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-8">
        <h2 className="text-sm font-semibold mb-3">Sync a Sleeper League</h2>
        <SyncLeagueForm />
        <div className="text-xs text-zinc-500 mt-3">
          Find your league ID in the Sleeper app URL: sleeper.com/leagues/
          <span className="font-mono">1234567890</span>/...
        </div>
      </div>

      <h2 className="text-sm font-semibold mb-3">Synced Leagues</h2>
      {leagues.length === 0 ? (
        <div className="text-sm text-zinc-500">No leagues synced yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm min-w-[560px]">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-4 py-2 text-left">League</th>
                <th className="px-4 py-2 text-left">Season</th>
                <th className="px-4 py-2 text-left">Format</th>
                <th className="px-4 py-2 text-right">Teams</th>
                <th className="px-4 py-2 text-right">Last Sync</th>
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
                  <td className="px-4 py-2 text-right text-zinc-500 tabular-nums">
                    {new Date(l.synced_at).toLocaleDateString()}
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
