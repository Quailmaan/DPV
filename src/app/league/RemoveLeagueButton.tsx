import { removeLeagueAction } from "./actions";

// Small inline form so the row's "Remove" button is a real form submission
// (server action) rather than a client click handler. Keeps the page a
// pure Server Component.
export default function RemoveLeagueButton({
  leagueId,
}: {
  leagueId: string;
}) {
  return (
    <form action={removeLeagueAction}>
      <input type="hidden" name="league_id" value={leagueId} />
      <button
        type="submit"
        className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 shadow-sm hover:bg-red-50 hover:text-red-700 hover:border-red-300 dark:hover:bg-red-950/40 dark:hover:text-red-300 dark:hover:border-red-900 transition-colors"
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
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
        Remove
      </button>
    </form>
  );
}
