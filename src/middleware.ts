import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Middleware: refreshes the Supabase auth session on every request and
// keeps cookies in sync between the request and the response. Without
// this, server components see stale tokens after the access token
// expires (typically 1 hour).
//
// It also gates the entire site behind authentication. Pylon is
// configured as members-only — every route requires a logged-in user
// EXCEPT the small public allow-list below (login, signup, OAuth
// callback, plus API endpoints that authenticate themselves via header
// or URL token rather than session cookie). Anything else redirects an
// unauthenticated visitor to /login?next=<original-path> so they bounce
// back to where they were trying to go after authenticating.
//
// API exceptions in detail:
//   /api/cron/*         — Bearer <CRON_SECRET> from Vercel Cron
//   /api/stripe/webhook — signed by Stripe (verifyWebhookSignature)
//   /email/unsubscribe  — UUID token in the URL (matches email_preferences)
//
// We also forward the request pathname to server components via the
// `x-pathname` header so the root layout can hide the site chrome on
// auth pages (the login page is the marketing landing — no nav).

const PUBLIC_PREFIXES = [
  "/login",
  "/signup",
  "/auth",
  "/api/cron",
  "/api/stripe/webhook",
  "/email/unsubscribe",
];

export async function middleware(request: NextRequest) {
  // Forward pathname so the root layout can decide whether to render
  // the header. Cloning the headers is cheap and keeps the original
  // request object unmodified.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-pathname", request.nextUrl.pathname);

  let response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({
            request: { headers: requestHeaders },
          });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // Touching getUser refreshes the access token if it's expired and
  // re-issues the cookies via setAll above. Don't remove this call.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some(
    (p) => path === p || path.startsWith(p + "/"),
  );

  if (!isPublic && !user) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("next", path + request.nextUrl.search);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  // Skip middleware for static assets and Next internals — auth refresh
  // doesn't need to run for /_next, favicon, images, etc.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
