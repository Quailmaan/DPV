import { NextResponse } from "next/server";
import type Stripe from "stripe";
import { stripe } from "@/lib/billing/stripe";
import { createAdminClient } from "@/lib/supabase/admin";

// Stripe webhook handler. Subscribed events (configure in the Stripe
// dashboard webhook UI):
//   - checkout.session.completed       — first-time activation
//   - customer.subscription.updated    — plan change, renewal, dunning
//   - customer.subscription.deleted    — cancellation took effect
//
// We DON'T trust the raw payload — Stripe signs every request with the
// webhook secret and we verify before reading. A forged POST with a
// fake "subscription active" payload would fail the signature check.
//
// Writes use the admin client because subscriptions has read-only RLS
// for end users — the webhook is the only writer.

// Force the request body parser off — Stripe needs the *raw* bytes to
// verify the signature. Next App Router gives us this when we read
// `req.text()` directly without JSON parsing.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "STRIPE_WEBHOOK_SECRET not configured" },
      { status: 500 },
    );
  }
  const sig = req.headers.get("stripe-signature");
  if (!sig) {
    return NextResponse.json({ error: "Missing signature" }, { status: 400 });
  }

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(body, sig, secret);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "verify failed";
    return NextResponse.json(
      { error: `Webhook signature verification failed: ${msg}` },
      { status: 400 },
    );
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await handleSubscriptionChange(event.data.object as Stripe.Subscription);
        break;
      default:
        // Ignore unsubscribed events. Returning 200 keeps Stripe from
        // retrying, which we want — we just don't care about this one.
        break;
    }
  } catch (err) {
    // Returning 500 makes Stripe retry with exponential backoff, which
    // gives us a free safety net if Supabase is briefly unavailable.
    const msg = err instanceof Error ? err.message : "handler failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}

// First-time activation. The Checkout session carries the customer ID
// and the new subscription ID; we fetch the subscription itself to
// pull current_period_end and the price ID.
async function handleCheckoutCompleted(s: Stripe.Checkout.Session) {
  if (s.mode !== "subscription") return;
  const customerId =
    typeof s.customer === "string" ? s.customer : s.customer?.id ?? null;
  const subscriptionId =
    typeof s.subscription === "string"
      ? s.subscription
      : s.subscription?.id ?? null;
  if (!customerId || !subscriptionId) return;

  const sub = await stripe().subscriptions.retrieve(subscriptionId);
  await upsertSubscriptionFromStripe(sub, customerId);
}

// Subscription updated / deleted. Stripe gives us the full sub object
// in the payload, so no extra fetch needed.
async function handleSubscriptionChange(sub: Stripe.Subscription) {
  const customerId =
    typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  await upsertSubscriptionFromStripe(sub, customerId);
}

async function upsertSubscriptionFromStripe(
  sub: Stripe.Subscription,
  customerId: string,
) {
  const admin = createAdminClient();

  // Resolve which app user this subscription belongs to. We stamp
  // user_id on the customer's metadata at checkout time, so a single
  // round-trip pulls it back. Falling back to the customer's metadata
  // keeps the webhook tolerant of subs created via Stripe dashboard.
  let userId: string | null =
    (sub.metadata?.user_id as string | undefined) ?? null;
  if (!userId) {
    const customer = await stripe().customers.retrieve(customerId);
    if (!customer.deleted) {
      userId = (customer.metadata?.user_id as string | undefined) ?? null;
    }
  }
  if (!userId) {
    // Orphan subscription. Log and bail — there's no app user to
    // associate it with. Keeps the webhook idempotent and surfaces the
    // problem in Stripe's webhook log instead of crashing.
    console.warn(
      `Stripe webhook: subscription ${sub.id} has no user_id metadata, ignoring.`,
    );
    return;
  }

  // First active price wins. We only sell single-line subscriptions so
  // there's never more than one item.
  const item = sub.items.data[0];
  const priceId = item?.price?.id ?? null;
  // Stripe's typings expose current_period_end on the subscription
  // item (since the 2024 API), with the legacy field also still
  // present on the parent. Read whichever is available.
  const periodEndUnix =
    (item as unknown as { current_period_end?: number })?.current_period_end ??
    (sub as unknown as { current_period_end?: number }).current_period_end ??
    null;

  await admin
    .from("subscriptions")
    .upsert(
      {
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: sub.id,
        status: sub.status,
        price_id: priceId,
        current_period_end: periodEndUnix
          ? new Date(periodEndUnix * 1000).toISOString()
          : null,
        cancel_at_period_end: sub.cancel_at_period_end ?? false,
      },
      { onConflict: "user_id" },
    );
}
