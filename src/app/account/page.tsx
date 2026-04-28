import { requireSession } from "@/lib/auth/session";
import ChangePasswordForm from "./ChangePasswordForm";
import ChangeUsernameForm from "./ChangeUsernameForm";

export default async function AccountPage() {
  const session = await requireSession();

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

      <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 mb-6">
        <h2 className="text-sm font-semibold mb-3">Username</h2>
        <ChangeUsernameForm currentUsername={session.username} />
      </section>

      <section className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
        <h2 className="text-sm font-semibold mb-3">Password</h2>
        <ChangePasswordForm />
      </section>
    </div>
  );
}
