"use client";

// "Which team is mine?" — persists to user_leagues.roster_id so the
// digest knows whose roster to analyze and the league page defaults its
// focus there.
//
// The component renders one of three views depending on state:
//
//   1. banner  — big call-to-action above the rankings table, shown only
//                when no team is picked yet (or right after sync via
//                ?pick=1). Big "Save" button.
//   2. summary — once a team IS picked, the header shows "My team:
//                {ownerName} · Change" — a quiet caption that confirms
//                the saved state and invites editing.
//   3. editing — toggled from the summary by clicking Change. Same
//                dropdown + button, but the button reads "Change" since
//                we're updating an existing pick. Cancel returns to
//                summary without saving.

import { useActionState, useState } from "react";
import { setMyTeamAction, type SetMyTeamFormState } from "../actions";

type RosterOption = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
};

const initial: SetMyTeamFormState = {};

function rosterLabel(r: RosterOption): string {
  return r.teamName ? `${r.ownerName} (${r.teamName})` : r.ownerName;
}

export default function MyTeamPicker({
  leagueId,
  currentRosterId,
  rosters,
  banner,
}: {
  leagueId: string;
  currentRosterId: number | null;
  rosters: RosterOption[];
  banner: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setMyTeamAction,
    initial,
  );
  const [editing, setEditing] = useState(false);

  const currentRoster =
    currentRosterId !== null
      ? rosters.find((r) => r.rosterId === currentRosterId) ?? null
      : null;
  const buttonLabel = currentRoster ? "Change" : "Save";

  // Header (banner=false) routing:
  //   - No team picked yet → render nothing. The banner above the
  //     rankings handles the call-to-action; a duplicate dropdown in
  //     the header would just confuse users.
  //   - Team picked, not editing → quiet "My team: X · Change" caption.
  //   - Team picked, editing → falls through to the inline form below.
  if (!banner) {
    if (!currentRoster) return null;
    if (!editing) {
      return (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-xs text-zinc-500">My team:</span>
          <span className="font-medium">{rosterLabel(currentRoster)}</span>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline underline-offset-2"
          >
            Change
          </button>
        </div>
      );
    }
  }

  // Banner + form share the dropdown markup; the wrapper styling is what
  // differs. Pulling it into a function keeps both branches in sync.
  const formMarkup = (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="league_id" value={leagueId} />
      <select
        name="roster_id"
        defaultValue={currentRosterId ?? ""}
        required
        disabled={pending}
        className={
          banner
            ? "rounded-md border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm min-w-[14rem]"
            : "rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
        }
      >
        <option value="" disabled>
          — select your team —
        </option>
        {rosters.map((r) => (
          <option key={r.rosterId} value={r.rosterId}>
            {rosterLabel(r)}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className={
          banner
            ? "px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-60"
            : "px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm disabled:opacity-60"
        }
      >
        {pending ? "Saving..." : buttonLabel}
      </button>
      {!banner && editing && (
        <button
          type="button"
          onClick={() => setEditing(false)}
          disabled={pending}
          className="text-xs text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 underline underline-offset-2"
        >
          Cancel
        </button>
      )}
      {state.error && (
        <span className="basis-full text-xs text-red-600 dark:text-red-400">
          {state.error}
        </span>
      )}
    </form>
  );

  if (banner) {
    return (
      <div className="rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4 mb-6">
        <h3 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200 mb-0.5">
          {currentRoster
            ? "Confirm your team"
            : "Pick your team to unlock your digest"}
        </h3>
        <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80 mb-3">
          We use this to focus the report card, sell-window flags, and
          trade ideas on your roster — and to know whose team to analyze
          for the weekly email digest.
        </p>
        {formMarkup}
      </div>
    );
  }

  // Header inline form — used when no team is picked yet OR the user
  // clicked Change on the summary.
  return formMarkup;
}
