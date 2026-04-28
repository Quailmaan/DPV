"use client";

// Email-prefs toggle on the account page. One checkbox: weekly digest
// on/off. Submits via a server action that upserts the email_preferences
// row. We expose `lastDigestSentAt` as a small caption so users can see
// when the most recent send happened — useful for "did I miss it?"
// debugging.

import { useActionState } from "react";
import {
  setEmailPrefsAction,
  type EmailPrefsFormState,
} from "./emailPrefsActions";

const initial: EmailPrefsFormState = {};

export default function EmailPrefsForm({
  weeklyDigestOptedIn,
  lastDigestSentAt,
}: {
  weeklyDigestOptedIn: boolean;
  lastDigestSentAt: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    setEmailPrefsAction,
    initial,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          name="opt_in"
          value="true"
          defaultChecked={weeklyDigestOptedIn}
          disabled={pending}
          className="mt-0.5 h-4 w-4 accent-emerald-600"
        />
        <span className="text-sm">
          <span className="font-medium block">
            Weekly digest email
          </span>
          <span className="text-zinc-500 text-xs">
            Sent every Friday morning. Includes your top sell-window
            flags, 2 trade ideas, and a roster verdict per league.
          </span>
        </span>
      </label>

      {/* Hidden "false" sibling so the form always sends *some* value
          when the box is unchecked — without it, the browser omits the
          field entirely and the action wouldn't know whether the user
          unchecked or just submitted with the box untouched. */}
      <input type="hidden" name="opt_in" value="false" />

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-xs font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save preferences"}
        </button>
        {lastDigestSentAt && (
          <span className="text-xs text-zinc-500">
            Last digest sent {new Date(lastDigestSentAt).toLocaleDateString()}
          </span>
        )}
      </div>

      {state.error && (
        <div className="text-xs text-red-600 dark:text-red-400">
          {state.error}
        </div>
      )}
      {state.info && (
        <div className="text-xs text-emerald-700 dark:text-emerald-400">
          {state.info}
        </div>
      )}
    </form>
  );
}
