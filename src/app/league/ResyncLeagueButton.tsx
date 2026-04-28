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
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 shadow-sm hover:bg-emerald-100 hover:border-emerald-300 dark:hover:bg-emerald-900/60 dark:hover:border-emerald-700 transition-colors"
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
          <path d="M21 12a9 9 0 1 1-3-6.7L21 8" />
          <path d="M21 3v5h-5" />
        </svg>
        Re-sync
      </button>
    </form>
  );
}
