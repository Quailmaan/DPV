import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { PylonWordmark } from "@/components/PylonLogo";
import GoogleSignInButton from "../GoogleSignInButton";
import SignUpForm from "./SignUpForm";

export default async function SignUpPage() {
  const session = await getCurrentSession();
  if (session) redirect("/league");

  return (
    <div className="w-full max-w-md">
      {/* Same brand block as the login page so signup feels like the
          natural next step rather than a different screen. */}
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
