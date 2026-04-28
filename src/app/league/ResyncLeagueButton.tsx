import { resyncLeagueAction } from "./actions";

// Re-runs the Sleeper sync for a league already linked to this user.
// Picks up roster moves and pick trades since the last sync. Same
// pure-form pattern as RemoveLeagueButton so the row stays a Server
// Component.
export default function ResyncLeagueButton({
  leagueId,
}: {
  leagueId: string;
}) {
  return (
    <form action={resyncLeagueAction}>
      <input type="hidden" name="league_id" value={leagueId} />
      <button
        type="submit"
        className="text-xs text-zinc-500 hover:text-emerald-600 dark:hover:text-emerald-400"
      >
        Re-sync
      </button>
    </form>
  );
}
