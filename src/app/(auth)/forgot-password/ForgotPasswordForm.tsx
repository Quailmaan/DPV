"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  requestPasswordResetAction,
  type AuthFormState,
} from "../actions";

const initial: AuthFormState = {};

export default function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(
    requestPasswordResetAction,
    initial,
  );

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Email
        </span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
          disabled={pending}
        />
        <span className="text-xs text-zinc-500">
          Use the email you registered with. Username lookups don&apos;t apply
          here — Supabase needs the email to send the link.
        </span>
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
        className="px-4 py-2 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50"
      >
        {pending ? "Sending link..." : "Send reset link"}
      </button>
      <div className="text-xs text-zinc-500 text-center pt-1">
        Remembered it?{" "}
        <Link
          href="/login"
          className="underline hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Back to sign in
        </Link>
      </div>
    </form>
  );
}
