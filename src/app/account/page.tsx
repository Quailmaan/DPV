import { requireSession } from "@/lib/auth/session";
import { getCurrentTier } from "@/lib/billing/tier";
import { createServerClient } from "@/lib/supabase/server";
import { SUPPORT_EMAIL, mailtoHref } from "@/lib/site/contact";
import ChangePasswordForm from "./ChangePasswordForm";
import ChangeUsernameForm from "./ChangeUsernameForm";
import EmailPrefsForm from "./EmailPrefsForm";
import { loadEmailPrefs } from "./emailPrefsActions";
import SubscriptionSection from "./SubscriptionSection";

type SearchParams = Promise<{ checkout?: string }>;

export default async function AccountPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const [session, tierState, sp, emailPrefs] = await Promise.all([
    requireSession(),
    getCurrentTier(),
    searchParams,
    loadEmailPrefs(),
  ]);

  // Pull the price_id alongside so the section can label "Pro Monthly"
  // vs "Pro Yearly" without re-querying Stripe.
  const sb = await createServerClient();
  const { data: subRow } = await sb
    .from("subscriptions")
    .select("price_id")
    .eq("user_id", session.userId)
    .maybeSingle();

  return (
    <div className="max-w-md mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Account</h1>
        <p className="text-sm text-zinc-500 mt-1">
          Signed in as{" "}
          <span className="font-mono">{session.email ?? session.username}</span>
          .
        </p>
      </div>

      <SubscriptionSection
        tierState={tierState}
        priceId={(subRow?.price_id as string | null) ?? null}
        checkoutSuccess={sp.checkout === "success"}
      />

      <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Username</h2>
        <ChangeUsernameForm currentUsername={session.username} />
      </section>

      <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Password</h2>
        <ChangePasswordForm />
      </section>

      <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Email preferences</h2>
        <EmailPrefsForm
          weeklyDigestOptedIn={emailPrefs.weeklyDigestOptedIn}
          lastDigestSentAt={emailPrefs.lastDigestSentAt}
        />
      </section>

      <div className="text-xs text-zinc-500">
        Need help with billing or your account?{" "}
        <a
          href={mailtoHref("Pylon account help")}
          className="underline hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          {SUPPORT_EMAIL}
        </a>
      </div>
    </div>
  );
}
