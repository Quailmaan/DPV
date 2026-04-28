"use client";

import { useActionState } from "react";
import { syncLeagueAction, type SyncFormState } from "./actions";

const initial: SyncFormState = {};

export default function SyncLeagueForm() {
  const [state, formAction, pending] = useActionState(
    syncLeagueAction,
    initial,
  );

  return (
    <form action={formAction} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input
          type="text"
          name="league_id"
          placeholder="Sleeper league ID (e.g. 1234567890123456)"
          required
          pattern="\d+"
          className="flex-1 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm"
          disabled={pending}
        />
        <button
          type="submit"
          disabled={pending}
          className="px-4 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50"
        >
          {pending ? "Syncing..." : "Sync"}
        </button>
      </div>
      {state.error && (
        <div className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </div>
      )}
    </form>
  );
}
