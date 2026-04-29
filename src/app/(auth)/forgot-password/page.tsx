import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import { PylonWordmark } from "@/components/PylonLogo";
import ForgotPasswordForm from "./ForgotPasswordForm";

// Sends users a Supabase password-recovery email. The link in the email
// hits /auth/callback?next=/reset-password, which exchanges the code for
// a session and routes to /reset-password.
//
// Already-signed-in users don't need this — bounce them to /account where
// they can change their password the normal way.
export default async function ForgotPasswordPage() {
  const session = await getCurrentSession();
  if (session) redirect("/account");

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
          Reset your password
        </h1>
        <p className="text-sm text-zinc-500 mb-5">
          Enter your email and we&apos;ll send a link to set a new password.
        </p>

        <ForgotPasswordForm />
      </div>
    </div>
  );
}
