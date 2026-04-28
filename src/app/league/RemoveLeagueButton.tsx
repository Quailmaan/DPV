"use client";

import { useFormStatus } from "react-dom";
import { removeLeagueAction } from "./actions";

// Inline form posting to a server action so the row stays on the
// pure server-side path. The inner client button uses useFormStatus
// to show a "Removing..." pending state — without it the click looks
// like a no-op until the page revalidates.
export default function RemoveLeagueButton({
  leagueId,
}: {
  leagueId: string;
}) {
  return (
    <form action={removeLeagueAction}>
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
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 shadow-sm hover:bg-red-50 hover:text-red-700 hover:border-red-300 dark:hover:bg-red-950/40 dark:hover:text-red-300 dark:hover:border-red-900 transition-colors disabled:opacity-70 disabled:cursor-wait"
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
          <path d="M3 6h18" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
      )}
      {pending ? "Removing..." : "Remove"}
    </button>
  );
}
