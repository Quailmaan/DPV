import Image from "next/image";
import Link from "next/link";
import { getCurrentSession } from "@/lib/auth/session";
import { PylonWordmark } from "@/components/PylonLogo";
import ResetPasswordForm from "./ResetPasswordForm";

// The recovery flow: the email link hits /auth/callback?next=/reset-password,
// the callback exchanges the code for a session, then bounces here. So if
// someone reaches this page with no session it's because the link expired,
// was already consumed, or someone navigated here directly. We render a
// helpful empty-state instead of the form in that case.
export default async function ResetPasswordPage() {
  const session = await getCurrentSession();

  return (
    <div className="w-full max-w-md">
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
      </div>

      <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 sm:p-6 shadow-sm">
        <h1 className="text-lg font-semibold tracking-tight mb-1">
          Set a new password
        </h1>
        {session ? (
          <>
            <p className="text-sm text-zinc-500 mb-5">
              Pick something you don&apos;t use elsewhere. You&apos;ll stay
              signed in after this.
            </p>
            <ResetPasswordForm />
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-500 mb-5">
              This reset link is no longer valid — it may have expired or
              already been used.
            </p>
            <Link
              href="/forgot-password"
              className="inline-block px-4 py-2 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300"
            >
              Request a new link
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
