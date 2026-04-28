"use client";

import { useFormStatus } from "react-dom";
import { openCustomerPortalAction } from "@/app/pricing/actions";

// Client wrapper so we can show a "Opening portal..." pending state
// while the server action creates the Stripe portal session and
// redirects. Without this the click feels dead for ~1 second.
export default function ManageSubscriptionButton() {
  return (
    <form action={openCustomerPortalAction}>
      <SubmitButton />
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm font-medium px-4 py-2 transition-colors disabled:opacity-70 disabled:cursor-wait"
    >
      {pending ? "Opening portal..." : "Manage subscription"}
    </button>
  );
}
