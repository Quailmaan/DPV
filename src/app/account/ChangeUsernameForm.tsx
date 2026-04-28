"use client";

import { useActionState } from "react";
import {
  setUsernameAction,
  type AuthFormState,
} from "../(auth)/actions";

const initial: AuthFormState = {};

export default function ChangeUsernameForm({
  currentUsername,
}: {
  currentUsername: string;
}) {
  const [state, formAction, pending] = useActionState(
    setUsernameAction,
    initial,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          New username
        </span>
        <input
          type="text"
          name="username"
          defaultValue={currentUsername}
          required
          minLength={3}
          maxLength={24}
          pattern="[a-zA-Z0-9_]+"
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
      <button
        type="submit"
        disabled={pending}
        className="self-start px-4 py-2 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50"
      >
        {pending ? "Saving..." : "Update username"}
      </button>
    </form>
  );
}
