import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

// Handles the redirect Supabase sends to after:
//   - email confirmation links (Phase 1)
//   - Google OAuth flow (Phase 2)
//
// Exchanges the `code` query param for a session. Then routes based on
// whether the user has finished onboarding:
//   - New user (placeholder username "user_<uuid8>") → /welcome
//   - Returning user → the `next` param (or /league as default)
//
// This means a returning Google OAuth user clicking "Continue with Google"
// won't get bounced to /welcome unnecessarily.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const requestedNext = searchParams.get("next");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const sb = await createServerClient();
  const { error: exchangeError } = await sb.auth.exchangeCodeForSession(code);
  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  // Look at the freshly created/refreshed session to decide where to go.
  const {
    data: { user },
  } = await sb.auth.getUser();
  if (!user) {
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  const { data: profile } = await sb
    .from("profiles")
    .select("username")
    .eq("user_id", user.id)
    .maybeSingle();

  const isPlaceholder =
    !profile?.username || /^user_[0-9a-f]{8}$/.test(profile.username);

  if (isPlaceholder) {
    return NextResponse.redirect(`${origin}/welcome`);
  }

  // Returning user: honor `next` if it's a safe internal path, else /league.
  const safeNext =
    requestedNext && requestedNext.startsWith("/") && requestedNext !== "/welcome"
      ? requestedNext
      : "/league";
  return NextResponse.redirect(`${origin}${safeNext}`);
}
