// Resend-backed email sender. One source of truth for outbound mail —
// the cron digest, future receipts, and any other transactional email
// route through here so subject formatting, from-address, reply-to,
// and unsubscribe headers stay consistent.
//
// ---- Required env vars ----------------------------------------------------
//
//   RESEND_API_KEY   — Resend dashboard → API Keys. Server-only, NEVER
//                      ship to the client.
//   EMAIL_FROM       — RFC-5322 from address on a Resend-verified domain.
//                      e.g. "Pylon <noreply@pylon.app>". For local dev
//                      against Resend's sandbox use "onboarding@resend.dev"
//                      — only delivers to the dashboard owner's email.
//   APP_BASE_URL     — Public origin (e.g. https://pylon.app) used to build
//                      absolute unsubscribe URLs.
//
// When RESEND_API_KEY is unset, send() logs to console and returns
// success without making the network call. This keeps `npm run dev`
// quiet — you don't need a Resend account just to run the app
// locally.
//
// ---- Compliance ----------------------------------------------------------
// Every email gets:
//   - reply_to = SUPPORT_EMAIL so users replying reach a real inbox
//   - List-Unsubscribe header (one-click) — Gmail/Yahoo will downrank
//     senders that omit this on bulk mail. The unsubscribe URL must be
//     a route that flips email_preferences.weekly_digest_opted_in to
//     false without requiring a login (token-based, single-use).

import { SUPPORT_EMAIL } from "@/lib/site/contact";

export type SendArgs = {
  to: string;
  subject: string;
  html: string;
  /** Optional plain-text fallback. Strongly recommended for deliverability. */
  text?: string;
  /**
   * Absolute URL the recipient can hit (GET) to unsubscribe with one
   * click. Becomes the List-Unsubscribe header. Required for any bulk
   * email — receipts/transactional one-offs can pass null.
   */
  unsubscribeUrl: string | null;
};

export type SendResult =
  | { ok: true; id: string | null; mode: "resend" | "logged" }
  | { ok: false; error: string };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from =
    process.env.EMAIL_FROM ?? `Pylon <onboarding@resend.dev>`;

  // Dev / no-key mode: log and pretend success. Lets the cron route be
  // exercised locally without forcing every dev to set up Resend.
  if (!apiKey) {
    console.log("[email:logged]", {
      to: args.to,
      from,
      subject: args.subject,
      unsubscribeUrl: args.unsubscribeUrl,
    });
    return { ok: true, id: null, mode: "logged" };
  }

  const headers: Record<string, string> = {};
  if (args.unsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${args.unsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  const body = {
    from,
    to: [args.to],
    subject: args.subject,
    html: args.html,
    text: args.text,
    reply_to: SUPPORT_EMAIL,
    headers,
  };

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return {
        ok: false,
        error: `Resend ${res.status}: ${errText.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as { id?: string };
    return { ok: true, id: json.id ?? null, mode: "resend" };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Public origin builder. Falls back to localhost in dev so the
// unsubscribe link in console-logged email is at least clickable.
export function appBaseUrl(): string {
  return (
    process.env.APP_BASE_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  );
}
