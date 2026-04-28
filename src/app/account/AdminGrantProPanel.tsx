"use client";

// Admin-only panel on /account. Two forms sharing one username field —
// Grant flips a user to Pro for free (synthetic subscription row),
// Revoke removes that row. The actions guard themselves with is_admin
// re-checks so the visibility gate on the parent page is just UX.
//
// We use two separate <form> elements so each button submits only its
// own action. Both forms read the same `username` input via JS — no
// page state is needed because the username field is just a uncontrolled
// text input copied into a hidden field per form via the synced ref.

import { useActionState, useRef } from "react";
import {
  grantProAction,
  revokeProAction,
  type AdminFormState,
} from "./adminActions";

const initial: AdminFormState = {};

export default function AdminGrantProPanel() {
  // One ref drives both forms — we mirror its value into hidden fields
  // on submit so we can keep two separate form actions.
  const usernameRef = useRef<HTMLInputElement>(null);

  const [grantState, grantAction, grantPending] = useActionState(
    grantProAction,
    initial,
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeProAction,
    initial,
  );

  const pending = grantPending || revokePending;

  // Most recent feedback wins — whichever action ran last.
  const error = grantState.error ?? revokeState.error;
  const info = grantState.info ?? revokeState.info;

  return (
    <section className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-5 mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Admin: Grant Pro</h2>
        <span className="text-[11px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-amber-200/70 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">
          Admin
        </span>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-3">
        Grants or revokes Pro for a user without going through Stripe.
        Refuses to touch users with a real Stripe subscription on file.
      </p>

      <label className="flex flex-col gap-1 mb-3">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Pylon username
        </span>
        <input
          ref={usernameRef}
          type="text"
          name="_display"
          required
          minLength={3}
          maxLength={24}
          pattern="[a-zA-Z0-9_]+"
          className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
          disabled={pending}
        />
      </label>

      <div className="flex gap-2">
        <form
          action={grantAction}
          onSubmit={(e) => {
            const hidden = e.currentTarget.elements.namedItem(
              "username",
            ) as HTMLInputElement | null;
            if (hidden) hidden.value = usernameRef.current?.value ?? "";
          }}
        >
          <input type="hidden" name="username" />
          <button
            type="submit"
            disabled={pending}
            className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium disabled:opacity-50"
          >
            {grantPending ? "Granting..." : "Grant Pro"}
          </button>
        </form>
        <form
          action={revokeAction}
          onSubmit={(e) => {
            const hidden = e.currentTarget.elements.namedItem(
              "username",
            ) as HTMLInputElement | null;
            if (hidden) hidden.value = usernameRef.current?.value ?? "";
          }}
        >
          <input type="hidden" name="username" />
          <button
            type="submit"
            disabled={pending}
            className="px-3 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-medium disabled:opacity-50"
          >
            {revokePending ? "Revoking..." : "Revoke Pro"}
          </button>
        </form>
      </div>

      {error && (
        <div className="mt-3 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
      {info && (
        <div className="mt-3 text-xs text-emerald-700 dark:text-emerald-400">
          {info}
        </div>
      )}
    </section>
  );
}
