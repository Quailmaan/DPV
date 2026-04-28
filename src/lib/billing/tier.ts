import type { SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@/lib/supabase/server";

// Tier system. Free is the default for everyone — anonymous browsers,
// signed-in users without a subscription, and signed-in users with a
// canceled / expired subscription. Pro requires an active or trialing
// Stripe subscription on file.
//
// Adding a new tier later (e.g. "founder" lifetime) means widening this
// union and updating `tierFromStatus`. Don't read raw Stripe statuses
// outside this file — keep the mapping in one place.
export type Tier = "free" | "pro";

// Stripe subscription statuses that grant Pro access. Anything else
// (incomplete, past_due, canceled, unpaid, paused) drops back to free.
// "trialing" is included so promo trials feel premium immediately.
const PRO_STATUSES = new Set(["active", "trialing"]);

export function tierFromStatus(status: string | null | undefined): Tier {
  return status && PRO_STATUSES.has(status) ? "pro" : "free";
}

export type TierState = {
  tier: Tier;
  // Raw Stripe status — useful for the account page ("Past due, please
  // update your card") and for debugging without re-querying Stripe.
  status: string | null;
  // Surfaced to the account page so we can show "Cancels on Mar 15".
  // Null when the user is on free or has no period_end on file.
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

const FREE_STATE: TierState = {
  tier: "free",
  status: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

// Resolve the current user's tier. Returns FREE_STATE for anonymous
// visitors and signed-in users without a subscription row. Server-side
// only — calls the request-scoped Supabase client which carries the
// auth cookie.
export async function getCurrentTier(): Promise<TierState> {
  const sb = await createServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return FREE_STATE;
  return readSubscriptionState(sb, user.id);
}

// Same as above but takes an explicit Supabase client + user id. Used
// by server actions that already have the session in hand and want to
// avoid the redundant auth.getUser() round-trip.
export async function readSubscriptionState(
  sb: SupabaseClient,
  userId: string,
): Promise<TierState> {
  const { data } = await sb
    .from("subscriptions")
    .select(
      "status, current_period_end, cancel_at_period_end",
    )
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return FREE_STATE;
  return {
    tier: tierFromStatus(data.status as string | null),
    status: (data.status as string | null) ?? null,
    currentPeriodEnd: (data.current_period_end as string | null) ?? null,
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
  };
}
