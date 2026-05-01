import Image from "next/image";
import { redirect } from "next/navigation";
import AuthMarketingPanel from "@/components/AuthMarketingPanel";
import { getCurrentSession } from "@/lib/auth/session";
import { PylonWordmark } from "@/components/PylonLogo";
import GoogleSignInButton from "../GoogleSignInButton";
import LoginForm from "./LoginForm";

type SearchParams = Promise<{
  next?: string;
  error?: string;
}>;

export default async function LoginPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const session = await getCurrentSession();
  if (session) redirect(sp.next ?? "/league");

  return (
    // Wider container than a typical auth form because we render the
    // marketing panel beside the form on desktop — keeps the value
    // props in front of the user during the login funnel too, since
    // some visitors land here directly from a saved bookmark or
    // search engine result and never see the home hero.
    <div className="w-full max-w-3xl">
      {/* Brand block — large logo + wordmark + tagline. This is the
          gate to the rest of the site, so it leans marketing-y rather
          than utilitarian. Centered above the two-column area. */}
      <div className="flex flex-col items-center text-center mb-8">
        <Image
          src="/pylon-logo-light.png"
          alt=""
          width={314}
          height={228}
          priority
          className="h-20 w-auto sm:h-24 dark:hidden"
        />
        <Image
          src="/pylon-logo-clean.png"
          alt=""
          width={314}
          height={228}
          priority
          className="hidden h-20 w-auto sm:h-24 dark:block"
        />
        <div className="mt-3">
          <PylonWordmark size="xl" />
        </div>
        <p className="mt-4 text-sm sm:text-base text-zinc-600 dark:text-zinc-400 max-w-sm">
          Data-driven dynasty fantasy football values, historical comps, and
          trade calibration — built for the way real leagues actually trade.
        </p>
      </div>

      {/* Two-column on desktop: form left, marketing right. Mobile
          stacks (single column) so returning users hit the sign-in
          form first without scrolling past marketing. */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight mb-1">Sign in</h1>
          <p className="text-sm text-zinc-500 mb-5">
            Use your username or the email you registered with.
          </p>

          {sp.error === "auth_callback_failed" && (
            <div className="mb-4 text-sm text-red-600 dark:text-red-400">
              That confirmation link expired or was already used. Try signing in.
            </div>
          )}
          {sp.error === "oauth_init_failed" && (
            <div className="mb-4 text-sm text-red-600 dark:text-red-400">
              Couldn&apos;t start the Google sign-in. Try again.
            </div>
          )}

          <GoogleSignInButton next={sp.next} />
          <Divider />
          <LoginForm next={sp.next} />
        </div>

        <AuthMarketingPanel />
      </div>
    </div>
  );
}

function Divider() {
  return (
    <div className="my-4 flex items-center gap-3 text-xs uppercase tracking-wide text-zinc-400">
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      <span>or</span>
      <div className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
    </div>
  );
}
