import Stripe from "stripe";

// Lazy singleton. Lazy because the env var must be present at call time,
// not at module load — Next.js sometimes imports modules during build
// before env is hydrated and we don't want the build to crash for users
// who haven't filled in Stripe keys yet.
//
// Pin the API version so a Stripe-side default change doesn't silently
// shift our webhook payload shape. Bump explicitly when we want the new
// shape and have tested against it.
let cached: Stripe | null = null;

export function stripe(): Stripe {
  if (cached) return cached;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "Missing STRIPE_SECRET_KEY — set it in .env.local and restart.",
    );
  }
  cached = new Stripe(key, {
    apiVersion: "2026-04-22.dahlia",
    typescript: true,
  });
  return cached;
}

// Two recurring prices: monthly and yearly. The yearly price ID nets the
// user a ~30% discount versus 12× monthly — Stripe handles the math, we
// just store both IDs and pick which one to charge based on the
// /pricing button the user clicked.
//
// Price IDs come from the Stripe dashboard (Products → click product →
// price card → "Copy price ID"). They start with `price_...`.
export type BillingPeriod = "monthly" | "yearly";

export function priceIdFor(period: BillingPeriod): string {
  const id =
    period === "monthly"
      ? process.env.STRIPE_PRICE_PRO_MONTHLY
      : process.env.STRIPE_PRICE_PRO_YEARLY;
  if (!id) {
    throw new Error(
      `Missing Stripe price ID for ${period} (set STRIPE_PRICE_PRO_${period.toUpperCase()}).`,
    );
  }
  return id;
}

// Detect which billing period a price ID corresponds to. Used by the
// account page so we can render "Pro Monthly" vs "Pro Yearly" without
// re-querying Stripe.
export function periodFromPriceId(
  priceId: string | null | undefined,
): BillingPeriod | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_PRO_MONTHLY) return "monthly";
  if (priceId === process.env.STRIPE_PRICE_PRO_YEARLY) return "yearly";
  return null;
}
