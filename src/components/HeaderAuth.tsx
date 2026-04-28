import Link from "next/link";
import { logOutAction } from "@/app/(auth)/actions";
import { getCurrentSession } from "@/lib/auth/session";

// Right-aligned auth corner of the header. Shows either:
//   - "Sign in" + "Sign up" links for guests
//   - Account / Sign out for signed-in users
//
// Kept as a Server Component so the cookie read is server-side and the
// header doesn't need a client hydration roundtrip just for auth state.
export default async function HeaderAuth() {
  const session = await getCurrentSession();

  if (!session) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <Link
          href="/login"
          className="text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-sm font-medium hover:bg-zinc-700 dark:hover:bg-zinc-300"
        >
          Sign up
        </Link>
      </div>
    );
  }

  // The auto-seeded placeholder username has form `user_<uuid8>`. If we
  // see one, prompt the user to finish onboarding via /welcome.
  const isPlaceholder = /^user_[0-9a-f]{8}$/.test(session.username);
  const displayLabel = isPlaceholder ? "Finish setup" : `@${session.username}`;
  const accountHref = isPlaceholder ? "/welcome" : "/account";

  return (
    <div className="flex items-center gap-3 text-sm">
      <Link
        href={accountHref}
        className="text-zinc-700 dark:text-zinc-200 hover:text-zinc-900 dark:hover:text-zinc-100 font-medium"
      >
        {displayLabel}
      </Link>
      <form action={logOutAction}>
        <button
          type="submit"
          className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          Sign out
        </button>
      </form>
    </div>
  );
}
