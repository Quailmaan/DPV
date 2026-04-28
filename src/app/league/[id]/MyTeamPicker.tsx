"use client";

// "Which team is mine?" picker. Persists the choice to user_leagues so
// the digest knows whose roster to analyze and the league page defaults
// the focused view to it.
//
// Two visual modes:
//   - banner=true   → big prompt above the rankings table when roster_id
//                     is null (or the user just synced and we asked them
//                     to pick via ?pick=1).
//   - banner=false  → compact dropdown in the header next to the league
//                     name. Used once a team is picked.

import { useState, type FormEvent } from "react";
import { setMyTeamAction } from "../actions";

type RosterOption = {
  rosterId: number;
  ownerName: string;
  teamName: string | null;
};

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
  // We render a hidden league_id field + a real-form submit. The native
  // form handles redirect via the server action's redirect() call — no
  // client-side router push needed.
  const [pending, setPending] = useState(false);
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    const fd = new FormData(e.currentTarget);
    if (!fd.get("roster_id")) {
      e.preventDefault();
      return;
    }
    setPending(true);
  }

  if (banner) {
    return (
      <div className="rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-4 mb-6">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200 mb-0.5">
              {currentRosterId === null
                ? "Pick your team to unlock your digest"
                : "Confirm your team"}
            </h3>
            <p className="text-xs text-emerald-800/80 dark:text-emerald-300/80 mb-3">
              We use this to focus the report card, sell-window flags, and
              trade ideas on your roster — and to know whose team to analyze
              for the weekly email digest.
            </p>
            <form
              action={setMyTeamAction}
              onSubmit={onSubmit}
              className="flex flex-wrap items-center gap-2"
            >
              <input type="hidden" name="league_id" value={leagueId} />
              <select
                name="roster_id"
                defaultValue={currentRosterId ?? ""}
                required
                disabled={pending}
                className="rounded-md border border-emerald-300 dark:border-emerald-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm min-w-[14rem]"
              >
                <option value="" disabled>
                  — select your team —
                </option>
                {rosters.map((r) => (
                  <option key={r.rosterId} value={r.rosterId}>
                    {r.ownerName}
                    {r.teamName ? ` (${r.teamName})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                disabled={pending}
                className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-60"
              >
                {pending ? "Saving..." : "Save"}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Compact header form. Submits to the same action; the page defaults
  // its focus to the persisted roster_id so a save also re-focuses.
  return (
    <form
      action={setMyTeamAction}
      onSubmit={onSubmit}
      className="flex items-center gap-2"
    >
      <input type="hidden" name="league_id" value={leagueId} />
      <label className="text-xs text-zinc-500">My team</label>
      <select
        name="roster_id"
        defaultValue={currentRosterId ?? ""}
        required
        disabled={pending}
        className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm"
      >
        <option value="" disabled>
          — select —
        </option>
        {rosters.map((r) => (
          <option key={r.rosterId} value={r.rosterId}>
            {r.ownerName}
            {r.teamName ? ` (${r.teamName})` : ""}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm disabled:opacity-60"
      >
        {pending ? "Saving..." : "Save"}
      </button>
    </form>
  );
}
