import Link from "next/link";
import type { TierState } from "@/lib/billing/tier";
import { periodFromPriceId } from "@/lib/billing/stripe";
import ManageSubscriptionButton from "./ManageSubscriptionButton";

// Account page subscription card. Free users see a Pro upsell. Pro
// users see their plan, renewal date, and a "manage" link that
// redirects them into Stripe's hosted Customer Portal (cancel, update
// card, switch monthly↔yearly all happen there).
export default function SubscriptionSection({
  tierState,
  priceId,
  checkoutSuccess,
}: {
  tierState: TierState;
  priceId: string | null;
  checkoutSuccess: boolean;
}) {
  const isPro = tierState.tier === "pro";
  const period = periodFromPriceId(priceId);

  return (
    <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-6">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold">Subscription</h2>
        <TierBadge tier={tierState.tier} />
      </div>

      {checkoutSuccess && (
        <div className="mb-3 rounded-md border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm text-emerald-800 dark:text-emerald-300">
          Payment received — welcome to Pro. (If your status still says Free,
          give it a few seconds for Stripe to confirm and refresh the page.)
        </div>
      )}

      {isPro ? (
        <div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-1">
            You&apos;re on{" "}
            <span className="font-semibold">
              Pro {period === "yearly" ? "Yearly" : period === "monthly" ? "Monthly" : ""}
            </span>
            .
          </p>
          {tierState.currentPeriodEnd && (
            <p className="text-xs text-zinc-500 mb-4">
              {tierState.cancelAtPeriodEnd ? (
                <>
                  Cancels on{" "}
                  <span className="font-medium">
                    {new Date(tierState.currentPeriodEnd).toLocaleDateString()}
                  </span>
                  . You&apos;ll keep Pro features until then.
                </>
              ) : (
                <>
                  Renews on{" "}
                  <span className="font-medium">
                    {new Date(tierState.currentPeriodEnd).toLocaleDateString()}
                  </span>
                  .
                </>
              )}
            </p>
          )}
          <ManageSubscriptionButton />
        </div>
      ) : (
        <div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Unlock unlimited leagues, league-aware trade tools, roster
            reports, and the trade finder.
          </p>
          <Link
            href="/pricing"
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2 transition-colors"
          >
            See plans
          </Link>
        </div>
      )}
    </section>
  );
}

function TierBadge({ tier }: { tier: "free" | "pro" }) {
  if (tier === "pro") {
    return (
      <span className="text-xs uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300">
        Pro
      </span>
    );
  }
  return (
    <span className="text-xs uppercase tracking-wider font-semibold px-2 py-0.5 rounded bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
      Free
    </span>
  );
}
