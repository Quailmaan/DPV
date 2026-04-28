"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireSession } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe, priceIdFor, type BillingPeriod } from "@/lib/billing/stripe";

// Server action: starts a Stripe Checkout session for the current user
// and 302s them to Stripe's hosted payment page. After payment, Stripe
// redirects them back to /account?checkout=success and our webhook
// flips their subscription row to active.
//
// Idempotent on the customer side — we look up an existing
// stripe_customer_id on `subscriptions` and reuse it when present, so
// re-clicking "upgrade" doesn't create a second Stripe customer.
export async function startCheckoutAction(formData: FormData): Promise<void> {
  const session = await requireSession("/login?next=/pricing");
  const periodRaw = String(formData.get("period") ?? "");
  if (periodRaw !== "monthly" && periodRaw !== "yearly") return;
  const period: BillingPeriod = periodRaw;

  // Origin for the success/cancel return URLs. We trust forwarded
  // headers because the request already came through our middleware.
  const h = await headers();
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost:3000"}`;

  const sb = await createServerClient();
  const { data: existing } = await sb
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", session.userId)
    .maybeSingle();

  let customerId: string;
  if (existing?.stripe_customer_id) {
    customerId = existing.stripe_customer_id;
  } else {
    // First-time checkout — create a Stripe customer and stash the ID
    // BEFORE redirecting to Stripe. The webhook also creates one if
    // missing, but eager creation lets us pre-fill the customer object
    // with our user_id so webhook reconciliation is trivial.
    //
    // Uses the admin client because we're writing to subscriptions
    // (which is RLS-locked to read-only for the owner). The Stripe
    // webhook also writes via admin for the same reason.
    const customer = await stripe().customers.create({
      email: session.email ?? undefined,
      metadata: { user_id: session.userId },
    });
    customerId = customer.id;
    const admin = createAdminClient();
    await admin
      .from("subscriptions")
      .upsert(
        {
          user_id: session.userId,
          stripe_customer_id: customerId,
          status: "incomplete",
        },
        { onConflict: "user_id" },
      );
  }

  const priceId = priceIdFor(period);
  const checkout = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // user_id stamped on the checkout session so the webhook can join
    // back to our `subscriptions` row even when a customer somehow
    // exists in Stripe but isn't yet on our side (manual creation in
    // the dashboard, etc.).
    subscription_data: {
      metadata: { user_id: session.userId },
    },
    // allow_promotion_codes lets us run discount campaigns without
    // touching code — generate a code in the Stripe dashboard, share
    // it, customers paste it on the checkout page.
    allow_promotion_codes: true,
    success_url: `${origin}/account?checkout=success`,
    cancel_url: `${origin}/pricing?checkout=canceled`,
  });

  if (!checkout.url) {
    throw new Error("Stripe didn't return a checkout URL.");
  }
  redirect(checkout.url);
}

// Server action: opens the Stripe-hosted Customer Portal for the
// current user. Lets them update their card, change plans, view
// invoices, or cancel — all without us building those screens.
export async function openCustomerPortalAction(): Promise<void> {
  const session = await requireSession("/login?next=/account");
  const h = await headers();
  const origin =
    h.get("origin") ??
    `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "localhost:3000"}`;

  const sb = await createServerClient();
  const { data } = await sb
    .from("subscriptions")
    .select("stripe_customer_id")
    .eq("user_id", session.userId)
    .maybeSingle();
  if (!data?.stripe_customer_id) {
    redirect("/pricing");
  }

  const portal = await stripe().billingPortal.sessions.create({
    customer: data!.stripe_customer_id,
    return_url: `${origin}/account`,
  });
  redirect(portal.url);
}
