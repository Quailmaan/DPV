import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/session";
import { getCurrentTier } from "@/lib/billing/tier";
import CheckoutButton from "./CheckoutButton";

// Public pricing page. Free is the entry tier — site read access, 1
// league, universal trade calc. Pro unlocks unlimited leagues, the
// league-aware trade tools, and the analytics features.
//
// We route Pro signups through Stripe Checkout (server action lives in
// CheckoutButton). Already-Pro users see a link to the customer
// portal instead of the buy buttons.
export default async function PricingPage() {
  const [session, tierState] = await Promise.all([
    getCurrentSession(),
    getCurrentTier(),
  ]);
  const isPro = tierState.tier === "pro";

  return (
    <div className="max-w-4xl mx-auto">
      <div className="text-center mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Pricing</h1>
        <p className="text-sm text-zinc-500 mt-2 max-w-xl mx-auto">
          Browse rankings free, forever. Pro unlocks unlimited leagues and
          the league-aware tools that turn the data into actual decisions.
          More Pro features ship every couple of weeks — your subscription
          covers them as they land.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Free tier */}
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Free</h2>
            <div className="text-2xl font-bold tabular-nums">$0</div>
          </div>
          <p className="text-sm text-zinc-500 mb-5">
            Everything you need to browse the data and try the product.
          </p>
          <ul className="text-sm space-y-2 mb-6">
            <Bullet>Full PYV rankings &amp; methodology</Bullet>
            <Bullet>Rookie rankings &amp; pre-draft prospects</Bullet>
            <Bullet>1 synced Sleeper league</Bullet>
            <Bullet>Universal trade calculator</Bullet>
            <Bullet>League power rankings &amp; team pages</Bullet>
            <Bullet>Player pages with HSM comps</Bullet>
          </ul>
          <div className="text-xs text-zinc-500">
            {session ? (
              "You're on Free."
            ) : (
              <Link
                href="/signup"
                className="text-zinc-700 dark:text-zinc-300 hover:underline"
              >
                Create a free account →
              </Link>
            )}
          </div>
        </div>

        {/* Pro tier */}
        <div className="rounded-lg border-2 border-emerald-300 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/20 p-6 relative">
          <div className="absolute -top-3 left-6 px-2 py-0.5 text-[11px] uppercase tracking-wider font-semibold rounded bg-emerald-600 text-white">
            Recommended
          </div>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Pro</h2>
            <div className="text-right">
              <div className="text-2xl font-bold tabular-nums">$7</div>
              <div className="text-xs text-zinc-500">/month</div>
            </div>
          </div>
          <p className="text-sm text-zinc-500 mb-5">
            Or <span className="font-semibold">$59/year</span> — 30% off
            monthly. Cancel anytime.
          </p>
          <ul className="text-sm space-y-2 mb-4">
            <Bullet pro>Everything in Free</Bullet>
            <Bullet pro>
              <strong>Unlimited</strong> synced leagues
            </Bullet>
            <Bullet pro>League-aware trade calculator</Bullet>
            <Bullet pro>Buy/Sell market signals</Bullet>
          </ul>
          <div className="mb-6 rounded-md border border-emerald-200/60 dark:border-emerald-900/60 bg-emerald-100/40 dark:bg-emerald-950/30 p-3">
            <div className="text-[11px] uppercase tracking-wider font-semibold text-emerald-700 dark:text-emerald-400 mb-1.5">
              Coming soon — included in Pro
            </div>
            <ul className="text-xs space-y-1 text-zinc-700 dark:text-zinc-300">
              <ComingSoon>Roster report card (contender vs. rebuild verdict)</ComingSoon>
              <ComingSoon>Trade finder</ComingSoon>
              <ComingSoon>Sell-window indicator</ComingSoon>
              <ComingSoon>Weekly email digest</ComingSoon>
              <ComingSoon>CSV export</ComingSoon>
            </ul>
          </div>

          {!session ? (
            <Link
              href="/signup?next=/pricing"
              className="block text-center w-full rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium px-4 py-2.5 transition-colors"
            >
              Sign up to upgrade
            </Link>
          ) : isPro ? (
            <Link
              href="/account"
              className="block text-center w-full rounded-md border border-emerald-600 text-emerald-700 dark:text-emerald-400 text-sm font-medium px-4 py-2.5 hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors"
            >
              Manage subscription
            </Link>
          ) : (
            <div className="space-y-2">
              <CheckoutButton period="yearly" label="Get Pro Yearly — $59" featured />
              <CheckoutButton period="monthly" label="Get Pro Monthly — $7" />
            </div>
          )}
        </div>
      </div>

      <div className="mt-10 text-center text-xs text-zinc-500 max-w-md mx-auto">
        Payments processed by Stripe. We don&apos;t store your card. Cancel
        anytime from your account page.
      </div>
    </div>
  );
}

function Bullet({
  children,
  pro,
}: {
  children: React.ReactNode;
  pro?: boolean;
}) {
  return (
    <li className="flex items-start gap-2">
      <svg
        className={`h-4 w-4 flex-shrink-0 mt-0.5 ${
          pro ? "text-emerald-600" : "text-zinc-400"
        }`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M5 12l5 5L20 7" />
      </svg>
      <span>{children}</span>
    </li>
  );
}

// Roadmap row — features promised in Pro but not yet shipped. Distinct
// styling so users see them as "soon" instead of mistakenly thinking
// they're already available. Honest > slick when you're new.
function ComingSoon({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <svg
        className="h-3.5 w-3.5 flex-shrink-0 mt-0.5 text-emerald-600/70"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
      <span>{children}</span>
    </li>
  );
}
