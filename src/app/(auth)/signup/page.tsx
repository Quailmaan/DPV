import Image from "next/image";
import { redirect } from "next/navigation";
import AuthMarketingPanel from "@/components/AuthMarketingPanel";
import { getCurrentSession } from "@/lib/auth/session";
import { PylonWordmark } from "@/components/PylonLogo";
import GoogleSignInButton from "../GoogleSignInButton";
import SignUpForm from "./SignUpForm";

export default async function SignUpPage() {
  const session = await getCurrentSession();
  if (session) redirect("/league");

  return (
    // Wider container than a typical auth form because we render the
    // marketing panel beside the form on desktop. Mobile stacks the
    // form on top and marketing below — the form is what they came for.
    <div className="w-full max-w-3xl">
      {/* Brand block — same as the login page so signup feels like the
          natural next step rather than a different screen. Centered
          full-width above the two-column area. */}
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

      {/* Two-column on desktop: form left, marketing right. The form
          renders first in the DOM so mobile users (single column) get
          straight to the action without scrolling past marketing copy
          they were just shown on the home hero. */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 shadow-sm">
          <h1 className="text-lg font-semibold tracking-tight mb-1">
            Create account
          </h1>
          <p className="text-sm text-zinc-500 mb-5">
            We&apos;ll send a confirmation email. After you verify, you can pick
            a username.
          </p>

          <GoogleSignInButton next="/welcome" />
          <Divider />
          <SignUpForm />
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
