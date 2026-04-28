"use client";

// Admin-only panel on /account. Renders a table of every Pylon user
// with a Grant/Revoke button per row. The actions guard themselves with
// is_admin re-checks so the visibility gate on the parent page is just
// UX. Each row's action submits the user's username via a hidden field
// to the same shared server action — one useActionState per action
// surfaces feedback at the bottom of the panel after revalidation
// re-renders the table with updated tier values.

import { useActionState, useMemo, useState } from "react";
import {
  grantProAction,
  revokeProAction,
  type AdminFormState,
  type AdminUserRow,
} from "./adminActions";

const initial: AdminFormState = {};

export default function AdminGrantProPanel({
  users,
}: {
  users: AdminUserRow[];
}) {
  const [grantState, grantAction, grantPending] = useActionState(
    grantProAction,
    initial,
  );
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeProAction,
    initial,
  );
  const [filter, setFilter] = useState("");

  const pending = grantPending || revokePending;
  // Most recent feedback wins — whichever action ran last.
  const error = grantState.error ?? revokeState.error;
  const info = grantState.info ?? revokeState.info;

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) =>
        u.username.toLowerCase().includes(q) ||
        (u.email ?? "").toLowerCase().includes(q),
    );
  }, [users, filter]);

  const proCount = users.filter((u) => u.tier === "pro").length;

  return (
    <section className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20 p-5 mb-6">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-sm font-semibold">Admin: Grant Pro</h2>
        <span className="text-[11px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-amber-200/70 text-amber-900 dark:bg-amber-900/60 dark:text-amber-200">
          Admin
        </span>
      </div>
      <p className="text-xs text-zinc-600 dark:text-zinc-400 mb-3">
        {users.length} users · {proCount} Pro. Grants don&apos;t go through
        Stripe; revokes only work on admin-granted rows (real Stripe
        subscribers must cancel via the customer portal).
      </p>

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter by username or email…"
        disabled={pending}
        className="w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm mb-3"
      />

      <div className="max-h-[420px] overflow-y-auto rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950 sticky top-0">
            <tr>
              <th className="px-3 py-2 text-left">Username</th>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left">Tier</th>
              <th className="px-3 py-2 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-3 py-4 text-center text-xs text-zinc-500"
                >
                  No users match.
                </td>
              </tr>
            ) : (
              filtered.map((u) => (
                <tr
                  key={u.userId}
                  className="border-t border-zinc-100 dark:border-zinc-800"
                >
                  <td className="px-3 py-2 font-medium">{u.username}</td>
                  <td className="px-3 py-2 text-zinc-500 text-xs">
                    {u.email ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <TierBadge
                      tier={u.tier}
                      isAdminGrant={u.isAdminGrant}
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    {u.tier === "free" ? (
                      <form action={grantAction}>
                        <input
                          type="hidden"
                          name="username"
                          value={u.username}
                        />
                        <button
                          type="submit"
                          disabled={pending}
                          className="px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium disabled:opacity-50"
                        >
                          {grantPending ? "..." : "Grant Pro"}
                        </button>
                      </form>
                    ) : u.isAdminGrant ? (
                      <form action={revokeAction}>
                        <input
                          type="hidden"
                          name="username"
                          value={u.username}
                        />
                        <button
                          type="submit"
                          disabled={pending}
                          className="px-2.5 py-1 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-xs font-medium disabled:opacity-50"
                        >
                          {revokePending ? "..." : "Revoke"}
                        </button>
                      </form>
                    ) : (
                      <span className="text-xs text-zinc-500">
                        Stripe-managed
                      </span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
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

function TierBadge({
  tier,
  isAdminGrant,
}: {
  tier: "free" | "pro";
  isAdminGrant: boolean;
}) {
  if (tier === "pro") {
    return (
      <span
        className={
          isAdminGrant
            ? "text-[11px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300"
            : "text-[11px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
        }
        title={isAdminGrant ? "Granted by admin" : "Stripe subscription"}
      >
        {isAdminGrant ? "Pro (admin)" : "Pro"}
      </span>
    );
  }
  return (
    <span className="text-[11px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      Free
    </span>
  );
}
