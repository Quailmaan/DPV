"use client";

// Account-page email change form. Mirrors ChangeUsernameForm: new value
// + password re-auth in one submit. The `info` line surfaces what the
// user should expect — Supabase sends a confirmation link to the new
// address and the change isn't live until they click it. We don't try
// to refresh the session here since the email won't actually flip
// until then.

import { useActionState } from "react";
import {
  changeEmailAction,
  type AuthFormState,
} from "../(auth)/actions";

const initial: AuthFormState = {};

export default function ChangeEmailForm({
  currentEmail,
}: {
  currentEmail: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    changeEmailAction,
    initial,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <div className="text-xs text-zinc-500">
        Current email:{" "}
        <span className="font-mono text-zinc-700 dark:text-zinc-300">
          {currentEmail ?? "(none)"}
        </span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          New email
        </span>
        <input
          type="email"
          name="new_email"
          required
          autoComplete="email"
          className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Confirm password
        </span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          required
          className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
          disabled={pending}
        />
      </label>
      {state.error && (
        <div className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </div>
      )}
      {state.info && (
        <div className="text-sm text-emerald-600 dark:text-emerald-400">
          {state.info}
        </div>
      )}
      <button
        type="submit"
        disabled={pending}
        className="self-start px-4 py-2 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50"
      >
        {pending ? "Sending..." : "Send confirmation link"}
      </button>
    </form>
  );
}
