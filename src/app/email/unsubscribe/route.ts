// One-click unsubscribe endpoint. Two surfaces converge here:
//
//   GET  — User clicked the "Unsubscribe" link in the email body. We
//          flip their opt-in to false and return a small confirmation
//          HTML page (no login required — looking up the token IS the
//          authentication).
//   POST — Gmail/Yahoo's "List-Unsubscribe-Post: List-Unsubscribe=One-Click"
//          flow. They POST to the same URL when a user clicks the
//          "Unsubscribe" affordance built into their inbox. Per the spec
//          (RFC 8058) this MUST work without a confirmation page and
//          MUST succeed on a single POST.
//
// Both branches do the same thing: lookup by unsubscribe_token, set
// weekly_digest_opted_in = false. We use the admin client because the
// recipient is unauthenticated when they hit this URL — RLS would
// otherwise reject the update.
//
// Note: page.tsx and route.ts can't coexist at the same path in Next's
// App Router, so we render the GET response as HTML directly here.

import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function flipOff(token: string): Promise<"ok" | "invalid"> {
  if (!token) return "invalid";
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("email_preferences")
    .update({ weekly_digest_opted_in: false })
    .eq("unsubscribe_token", token)
    .select("user_id")
    .maybeSingle();
  if (error || !data) return "invalid";
  return "ok";
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  const result = token ? await flipOff(token) : "invalid";

  const body =
    result === "ok"
      ? confirmHtml({
          title: "Unsubscribed",
          message:
            "You've been removed from the Pylon weekly digest. You won't receive any more weekly emails.",
        })
      : confirmHtml({
          title: "Link expired",
          message:
            "We couldn't match this unsubscribe link to an account. The link may be from an older email. Sign in to manage email preferences from your account page.",
        });

  return new Response(body, {
    status: result === "ok" ? 200 : 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  let token = url.searchParams.get("token") ?? "";

  // Form-encoded body fallback. Some clients pass the token via body
  // when issuing the One-Click POST — read both, prefer the URL value
  // since that's what we actually put in the List-Unsubscribe header.
  if (!token) {
    try {
      const text = await req.text();
      const form = new URLSearchParams(text);
      token = form.get("token") ?? "";
    } catch {
      // ignore — fall through to the missing-token branch
    }
  }

  const result = await flipOff(token);
  if (result !== "ok") {
    return new Response("Invalid or expired token", { status: 404 });
  }
  // RFC 8058 requires a 2xx; the body is irrelevant.
  return new Response("ok", { status: 200 });
}

// Tiny inline HTML page — the unsubscribe confirmation is one of the
// few pages the user can hit completely cold (different browser, no
// session, no styles loaded). Inline everything; one self-contained doc.
function confirmHtml(args: { title: string; message: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHtml(args.title)} — Pylon</title>
<style>
  body { margin: 0; padding: 64px 20px; background: #f4f4f5; color: #18181b;
         font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
         display: flex; justify-content: center; }
  main { max-width: 480px; text-align: center; }
  h1 { font-size: 24px; margin: 0 0 12px; }
  p { font-size: 14px; color: #52525b; line-height: 1.55; margin: 0 0 12px; }
  a { color: #16a34a; text-decoration: underline; }
  .pill { display: inline-block; font-size: 11px; text-transform: uppercase;
          letter-spacing: 0.08em; color: #16a34a; font-weight: 600;
          margin-bottom: 12px; }
</style>
</head>
<body>
<main>
  <div class="pill">Pylon</div>
  <h1>${escapeHtml(args.title)}</h1>
  <p>${escapeHtml(args.message)}</p>
  <p>Want to come back?
    <a href="/account">Manage email preferences</a>.
  </p>
</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
