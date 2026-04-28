import { redirect } from "next/navigation";
import { getCurrentSession } from "@/lib/auth/session";
import WelcomeForm from "./WelcomeForm";

export default async function WelcomePage() {
  const session = await getCurrentSession();
  if (!session) redirect("/login?next=/welcome");

  // If they've already picked a real username, they don't belong here.
  // The auto-seeded username has the form `user_<8 hex chars>`.
  const isPlaceholder = /^user_[0-9a-f]{8}$/.test(session.username);
  if (!isPlaceholder) redirect("/account");

  return (
    <div className="max-w-sm mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-1">
        Welcome to Pylon
      </h1>
      <p className="text-sm text-zinc-500 mb-6">
        Pick a username. You&apos;ll use it to sign in.
      </p>
      <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <WelcomeForm />
      </div>
    </div>
  );
}
