import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
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
    <div className="max-w-sm mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Sign in</h1>
      <p className="text-sm text-zinc-500 mb-6">
        Sign in with your username or the email you registered with.
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
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <GoogleSignInButton next={sp.next} />
        <Divider />
        <LoginForm next={sp.next} />
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
