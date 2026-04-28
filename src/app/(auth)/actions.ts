"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerClient } from "@/lib/supabase/server";

export type AuthFormState = {
  error?: string;
  info?: string;
};

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

// ---------------- helpers ----------------

function readString(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

// Username → email lookup. Uses the admin client so the lookup itself
// isn't blocked by RLS (the profiles row is public-readable for username,
// but we want the email which lives in auth.users — admin-only). Returns
// null if no such username exists.
async function resolveUsernameToEmail(
  username: string,
): Promise<string | null> {
  if (!USERNAME_RE.test(username)) return null;
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("user_id")
    .ilike("username", username)
    .maybeSingle();
  if (!profile) return null;
  const { data: userRes } = await admin.auth.admin.getUserById(
    profile.user_id,
  );
  return userRes?.user?.email ?? null;
}

// ---------------- sign up ----------------

export async function signUpAction(
  _prev: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const email = readString(form, "email").toLowerCase();
  const password = readString(form, "password");

  if (!email || !email.includes("@")) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const sb = await createServerClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error } = await sb.auth.signUp({
    email,
    password,
    options: {
      // After the user clicks the verification link, send them to /welcome
      // to pick their username.
      emailRedirectTo: `${origin}/auth/callback?next=/welcome`,
    },
  });

  if (error) {
    return { error: error.message };
  }

  return {
    info: "Check your email to confirm your account, then sign in.",
  };
}

// ---------------- log in (email or username) ----------------

export async function logInAction(
  _prev: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const handle = readString(form, "handle");
  const password = readString(form, "password");
  const next = readString(form, "next") || "/league";

  if (!handle || !password) {
    return { error: "Enter your username/email and password." };
  }

  // If the handle has @, treat it as email. Otherwise look up the
  // username → email mapping via the admin client.
  let email: string | null = null;
  if (handle.includes("@")) {
    email = handle.toLowerCase();
  } else {
    email = await resolveUsernameToEmail(handle);
    if (!email) {
      return { error: "No account with that username." };
    }
  }

  const sb = await createServerClient();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    return { error: error.message };
  }

  revalidatePath("/", "layout");
  redirect(next.startsWith("/") ? next : "/league");
}

// ---------------- log out ----------------

export async function logOutAction(): Promise<void> {
  const sb = await createServerClient();
  await sb.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/");
}

// ---------------- Google OAuth ----------------

// Kicks off the Google OAuth flow. Supabase returns a redirect URL pointing
// at Google's consent screen; we relay the user there. After consent,
// Google sends them back to /auth/callback with a `code`, which the
// callback route exchanges for a session.
//
// The redirect-after-auth target is encoded into the callback URL via the
// `next` query param. New OAuth users land on /welcome to pick a username
// (the auto-seeded `user_<uuid8>` placeholder is detected there);
// returning users go straight to /league.
export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  const next = String(formData.get("next") ?? "/welcome");
  const sb = await createServerClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const safeNext = next.startsWith("/") ? next : "/welcome";

  const { data, error } = await sb.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(safeNext)}`,
      // Always present the account chooser so users on shared devices can
      // pick the right Google account instead of being silently signed in
      // with the last one they used.
      queryParams: { prompt: "select_account" },
    },
  });

  if (error || !data?.url) {
    redirect(`/login?error=oauth_init_failed`);
  }
  redirect(data.url);
}

// ---------------- pick / change username ----------------

export async function setUsernameAction(
  _prev: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const username = readString(form, "username");
  const password = readString(form, "password"); // optional re-auth

  if (!USERNAME_RE.test(username)) {
    return {
      error: "Username must be 3-24 characters, letters/numbers/underscore.",
    };
  }

  const sb = await createServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return { error: "You must be signed in." };
  }

  // For a CHANGE (vs initial pick), require password re-verification. We
  // detect "change" by checking whether the user already has a non-default
  // username set. The trigger seeds "user_<uuid8>" so any value not
  // matching that pattern means they've already chosen one.
  const { data: existing } = await sb
    .from("profiles")
    .select("username")
    .eq("user_id", user.id)
    .maybeSingle();
  const isChange =
    !!existing?.username && !/^user_[0-9a-f]{8}$/.test(existing.username);

  if (isChange) {
    if (!password) {
      return { error: "Confirm your password to change username." };
    }
    if (!user.email) {
      return { error: "Account has no email on file." };
    }
    const { error: reauthError } = await sb.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (reauthError) {
      return { error: "Password incorrect." };
    }
  }

  // Case-insensitive uniqueness check before writing — surfaces a clean
  // error rather than a Postgres unique-violation string.
  const { data: clash } = await sb
    .from("profiles")
    .select("user_id")
    .ilike("username", username)
    .neq("user_id", user.id)
    .maybeSingle();
  if (clash) {
    return { error: "That username is taken." };
  }

  const { error: updateError } = await sb
    .from("profiles")
    .update({ username })
    .eq("user_id", user.id);
  if (updateError) {
    return { error: updateError.message };
  }

  revalidatePath("/", "layout");
  redirect("/account");
}

// ---------------- change email ----------------

// Email change goes through a verification step on Supabase's side.
// `auth.updateUser({ email })` doesn't immediately swap the address —
// Supabase sends a "Confirm your new email" link to the new address (and
// to the old one, if "Secure email change" is enabled in the project),
// and only flips the email after the user clicks. We surface that
// expectation in the success message so users don't think it's broken
// when their old email still works for login afterward.
//
// Re-auth is required: changing the recovery channel is the kind of
// thing a session-hijacker would do, so we always confirm the password
// before initiating the change.
export async function changeEmailAction(
  _prev: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const newEmail = readString(form, "new_email").toLowerCase();
  const password = readString(form, "password");

  if (!newEmail || !newEmail.includes("@")) {
    return { error: "Enter a valid email address." };
  }
  if (!password) {
    return { error: "Confirm your password to change email." };
  }

  const sb = await createServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user || !user.email) {
    return { error: "You must be signed in." };
  }
  if (newEmail === user.email.toLowerCase()) {
    return { error: "That's already your email." };
  }

  const { error: reauthError } = await sb.auth.signInWithPassword({
    email: user.email,
    password,
  });
  if (reauthError) {
    return { error: "Password incorrect." };
  }

  // Ask Supabase to dispatch the confirmation link. The new email isn't
  // active until the user clicks it; emailRedirectTo brings them back to
  // /account so they see the updated address.
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { error: updateError } = await sb.auth.updateUser(
    { email: newEmail },
    { emailRedirectTo: `${origin}/auth/callback?next=/account` },
  );
  if (updateError) {
    return { error: updateError.message };
  }

  return {
    info: `Confirmation link sent to ${newEmail}. Click it to finish the change — your old email keeps working until then.`,
  };
}

// ---------------- change password ----------------

export async function changePasswordAction(
  _prev: AuthFormState,
  form: FormData,
): Promise<AuthFormState> {
  const currentPassword = readString(form, "current_password");
  const newPassword = readString(form, "new_password");

  if (newPassword.length < 8) {
    return { error: "New password must be at least 8 characters." };
  }

  const sb = await createServerClient();
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user || !user.email) {
    return { error: "You must be signed in." };
  }

  const { error: reauthError } = await sb.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (reauthError) {
    return { error: "Current password incorrect." };
  }

  const { error: updateError } = await sb.auth.updateUser({
    password: newPassword,
  });
  if (updateError) {
    return { error: updateError.message };
  }

  return { info: "Password updated." };
}
