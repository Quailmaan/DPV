"use client";

import { useFormStatus } from "react-dom";
import { resyncLeagueAction } from "./actions";

// Re-runs the Sleeper sync for a league already linked to this user.
// Picks up roster moves and pick trades since the last sync.
//
// Server actions don't surface pending state by default — without
// useFormStatus the click feels like a no-op (the page eventually
// revalidates but there's no visual signal in between). The inner
// button uses useFormStatus to flip into a "Syncing..." disabled state
// the instant the form submits.
export default function ResyncLeagueButton({
  leagueId,
}: {
  leagueId: string;
}) {
  return (
    <form action={resyncLeagueAction}>
      <input type="hidden" name="league_id" value={leagueId} />
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-1.5 text-xs font-medium text-emerald-800 dark:text-emerald-300 shadow-sm hover:bg-emerald-100 hover:border-emerald-300 dark:hover:bg-emerald-900/60 dark:hover:border-emerald-700 transition-colors disabled:opacity-70 disabled:cursor-wait"
    >
      {pending ? (
        <svg
          className="h-3.5 w-3.5 animate-spin"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 12a9 9 0 1 1-6.2-8.55" />
        </svg>
      ) : (
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
      )}
      {pending ? "Syncing..." : "Re-sync"}
    </button>
  );
}
