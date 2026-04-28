"use client";

import Link from "next/link";
import { useActionState } from "react";
import { logInAction, type AuthFormState } from "../actions";

const initial: AuthFormState = {};

export default function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(logInAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Username or email
        </span>
        <input
          type="text"
          name="handle"
          autoComplete="username"
          required
          className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-2 text-sm"
          disabled={pending}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wide text-zinc-500">
          Password
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
        className="px-4 py-2 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300 disabled:opacity-50"
      >
        {pending ? "Signing in..." : "Sign in"}
      </button>
      <div className="text-xs text-zinc-500 text-center pt-1">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="underline hover:text-zinc-900 dark:hover:text-zinc-100">
          Sign up
        </Link>
      </div>
    </form>
  );
}
