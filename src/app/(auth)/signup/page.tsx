import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import GoogleSignInButton from "../GoogleSignInButton";
import SignUpForm from "./SignUpForm";

export default async function SignUpPage() {
  const session = await getCurrentSession();
  if (session) redirect("/league");

  return (
    <div className="max-w-sm mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">
        Create account
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        We&apos;ll send a confirmation email. After you verify, you can pick a
        username.
      </p>
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
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
