"use client";

import { useFormStatus } from "react-dom";
import { startCheckoutAction } from "./actions";

// Submit button that redirects to Stripe Checkout. Form-action pattern
// keeps this a server action with no client-side Stripe SDK exposure
// (key stays on the server, customer creation happens server-side).
//
// useFormStatus surfaces a "Redirecting..." pending state so the few
// hundred ms between click and 302 doesn't feel like a no-op.
export default function CheckoutButton({
  period,
  label,
  featured,
}: {
  period: "monthly" | "yearly";
  label: string;
  featured?: boolean;
}) {
  return (
    <form action={startCheckoutAction}>
      <input type="hidden" name="period" value={period} />
      <SubmitButton label={label} featured={featured} />
    </form>
  );
}

function SubmitButton({
  label,
  featured,
}: {
  label: string;
  featured?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        featured
          ? "block text-center w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2.5 transition-colors disabled:opacity-70 disabled:cursor-wait"
          : "block text-center w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 text-sm font-medium px-4 py-2.5 transition-colors disabled:opacity-70 disabled:cursor-wait"
      }
    >
      {pending ? "Redirecting to Stripe..." : label}
    </button>
  );
}
