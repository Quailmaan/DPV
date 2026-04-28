import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

export type SessionProfile = {
  userId: string;
  email: string | null;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
};

// Resolve the current signed-in user + their profiles row. Returns null
// when not signed in. Use this in Server Components / Server Actions
// that should render differently for guests vs authenticated users.
export async function getCurrentSession(): Promise<SessionProfile | null> {
  const sb = await createServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) return null;

  const { data: profile } = await sb
    .from("profiles")
    .select("username, display_name, is_admin")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!profile) {
    // The auth.users insert trigger creates a profiles row, but a brand
    // new signup may race the trigger. Surface a stub so callers can
    // detect "needs welcome" and route to /welcome.
    return {
      userId: user.id,
      email: user.email ?? null,
      username: "",
      displayName: null,
      isAdmin: false,
    };
  }

  return {
    userId: user.id,
    email: user.email ?? null,
    username: profile.username,
    displayName: profile.display_name,
    isAdmin: profile.is_admin,
  };
}

// Server-action helper: redirect to /login if the visitor isn't signed in.
// Returns the session for inline use.
export async function requireSession(
  redirectPath = "/login",
): Promise<SessionProfile> {
  const session = await getCurrentSession();
  if (!session) redirect(redirectPath);
  return session;
}
