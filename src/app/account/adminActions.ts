"use server";

// Admin-only server actions for granting / revoking Pro without going
// through Stripe. Used by the AdminGrantProPanel on /account, which is
// only rendered for users with profiles.is_admin = true.
//
// SAFETY MODEL
// ------------
// Real Stripe customer IDs start with `cus_`. We use a synthetic
// `admin_grant_<userid>` prefix for grant rows so the webhook logic and
// the Customer Portal can never confuse the two. Critically:
//
//   - Grant refuses to overwrite a row whose stripe_customer_id starts
//     with `cus_` (would clobber a paying customer's Stripe link).
//   - Revoke only deletes rows with the `admin_grant_` prefix (never
//     touches real subscribers — they have to cancel in Stripe).
//
// Both actions also re-check is_admin server-side. Trusting the page
// component's gate is fine for UX, but the action itself is the
// authority on who can mutate.

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";

export type AdminFormState = {
  error?: string;
  info?: string;
};

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function readString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

// Resolve a Pylon username to its auth user id. Case-insensitive match
// against the profiles table. Returns null when nothing found.
async function lookupUserIdByUsername(
  admin: ReturnType<typeof createAdminClient>,
  username: string,
): Promise<string | null> {
  const { data } = await admin
    .from("profiles")
    .select("user_id")
    .ilike("username", username)
    .maybeSingle();
  return (data?.user_id as string | null) ?? null;
}

async function ensureAdmin(): Promise<{ ok: true } | AdminFormState> {
  const session = await requireSession();
  if (!session.isAdmin) {
    return { error: "Admin only." };
  }
  return { ok: true };
}

// ----------------- user list -----------------

export type AdminUserRow = {
  userId: string;
  username: string;
  email: string | null;
  tier: "free" | "pro";
  // True when the Pro grant came from this admin panel (synthetic
  // admin_grant_ row) rather than a real Stripe subscription. The UI
  // uses this to show the right action button (Revoke vs. "managed in
  // Stripe").
  isAdminGrant: boolean;
};

// Load every Pylon user with their tier + Pro source. Admin-only (the
// session check is duplicated server-side so a non-admin who somehow
// got the import path can't pull the email list). Joins three sources:
//   - public.profiles      → username, user_id
//   - auth.users           → email (admin client only)
//   - public.subscriptions → status, stripe_customer_id (for tier + source)
//
// Single perPage=1000 page covers Pylon for a long while; revisit if
// the user count outgrows that.
export async function loadAdminUserList(): Promise<AdminUserRow[]> {
  const guard = await ensureAdmin();
  if ("error" in guard) return [];

  const admin = createAdminClient();

  const [profilesRes, subsRes, authRes] = await Promise.all([
    admin
      .from("profiles")
      .select("user_id, username")
      .order("username", { ascending: true }),
    admin
      .from("subscriptions")
      .select("user_id, status, stripe_customer_id"),
    admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);

  const profiles = (profilesRes.data ?? []) as Array<{
    user_id: string;
    username: string;
  }>;
  const subs = (subsRes.data ?? []) as Array<{
    user_id: string;
    status: string | null;
    stripe_customer_id: string | null;
  }>;

  // Sub state per user: derived tier + whether it's an admin grant.
  type SubState = { tier: "free" | "pro"; isAdminGrant: boolean };
  const subMap = new Map<string, SubState>();
  for (const s of subs) {
    const status = s.status ?? "";
    const tier: "free" | "pro" =
      status === "active" || status === "trialing" ? "pro" : "free";
    subMap.set(s.user_id, {
      tier,
      isAdminGrant: !!s.stripe_customer_id?.startsWith("admin_grant_"),
    });
  }

  const emailMap = new Map<string, string>();
  for (const u of authRes.data?.users ?? []) {
    if (u.email) emailMap.set(u.id, u.email);
  }

  return profiles.map((p) => {
    const sub = subMap.get(p.user_id);
    return {
      userId: p.user_id,
      username: p.username,
      email: emailMap.get(p.user_id) ?? null,
      tier: sub?.tier ?? "free",
      isAdminGrant: sub?.isAdminGrant ?? false,
    };
  });
}

// Grant Pro to a user by username. Idempotent — if the user already has
// an admin_grant_ row we just refresh status; if they have a real Stripe
// row we refuse rather than corrupt billing state.
export async function grantProAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const guard = await ensureAdmin();
  if ("error" in guard) return guard;

  const username = readString(form, "username");
  if (!USERNAME_RE.test(username)) {
    return { error: "Enter a valid username." };
  }

  const admin = createAdminClient();
  const userId = await lookupUserIdByUsername(admin, username);
  if (!userId) {
    return { error: `No user with username "${username}".` };
  }

  // Refuse to clobber a real Stripe-backed subscription. Anything
  // starting with `cus_` came from Stripe; we leave those alone.
  const { data: existing } = await admin
    .from("subscriptions")
    .select("stripe_customer_id, status")
    .eq("user_id", userId)
    .maybeSingle();
  if (
    existing?.stripe_customer_id &&
    !String(existing.stripe_customer_id).startsWith("admin_grant_")
  ) {
    return {
      error: `${username} has a real Stripe subscription. Use the Stripe dashboard to manage it.`,
    };
  }

  // Far-future renewal so the account page renders cleanly ("Renews on
  // ..."), and so the Pro check (status active) keeps passing forever.
  // 100 years out is well past any plausible product lifetime.
  const farFuture = new Date();
  farFuture.setFullYear(farFuture.getFullYear() + 100);

  const { error: upsertError } = await admin.from("subscriptions").upsert(
    {
      user_id: userId,
      stripe_customer_id: `admin_grant_${userId}`,
      stripe_subscription_id: null,
      status: "active",
      price_id: null,
      current_period_end: farFuture.toISOString(),
      cancel_at_period_end: false,
    },
    { onConflict: "user_id" },
  );
  if (upsertError) {
    return { error: upsertError.message };
  }

  revalidatePath("/account");
  return { info: `Granted Pro to ${username}.` };
}

// Revoke an admin-granted Pro. Refuses to delete rows that came from
// Stripe — those have to be canceled in the Stripe dashboard or via
// the Customer Portal so the webhook can sync correctly.
export async function revokeProAction(
  _prev: AdminFormState,
  form: FormData,
): Promise<AdminFormState> {
  const guard = await ensureAdmin();
  if ("error" in guard) return guard;

  const username = readString(form, "username");
  if (!USERNAME_RE.test(username)) {
    return { error: "Enter a valid username." };
  }

  const admin = createAdminClient();
  const userId = await lookupUserIdByUsername(admin, username);
  if (!userId) {
    return { error: `No user with username "${username}".` };
  }

  const { data: existing } = await admin
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!existing) {
    return { info: `${username} has no subscription row — already on Free.` };
  }
  if (!String(existing.stripe_customer_id).startsWith("admin_grant_")) {
    return {
      error: `${username} is on a real Stripe plan — revoke in Stripe, not here.`,
    };
  }

  const { error: deleteError } = await admin
    .from("subscriptions")
    .delete()
    .eq("user_id", userId);
  if (deleteError) {
    return { error: deleteError.message };
  }

  revalidatePath("/account");
  return { info: `Revoked Pro from ${username}.` };
}
