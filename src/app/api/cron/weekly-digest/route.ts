// Weekly digest cron endpoint. Vercel Cron Jobs hit this once a week
// (see vercel.json). The handler:
//
//   1. Authenticates via Bearer <CRON_SECRET> header. Vercel Cron sends
//      this automatically when you set CRON_SECRET in the project env;
//      requests without it (random scrapers, manual curl) get 401.
//   2. Pulls every email_preferences row with weekly_digest_opted_in=true.
//   3. Skips users whose last_digest_sent_at is < 6 days ago. This makes
//      the route idempotent for re-fires (Vercel guarantees cron triggers
//      "at least once" — duplicates can happen).
//   4. Per user: loads their session profile, builds digest blocks, calls
//      the Resend sender, updates last_digest_sent_at on success.
//   5. Returns a JSON summary (sent / skipped / errors) so we can read the
//      Vercel logs and tell what happened without poking the DB.
//
// The route runs on Node (not Edge) because Resend's SDK + Supabase admin
// SDK both expect Node APIs (fetch is fine, but we set this explicitly to
// avoid future surprises).
//
// We use the admin Supabase client throughout — RLS would otherwise hide
// every user's prefs from us, since there's no auth.uid() in a cron run.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, appBaseUrl } from "@/lib/email/sender";
import { buildWeeklyDigest } from "@/lib/email/weeklyDigest";
import { loadDigestLeagues } from "@/lib/email/digestData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Cap the function timeout — a thousand-user blast at ~1s/user fits in
// 60s, and we don't want Vercel killing us mid-loop. If the user count
// outgrows this we'll need to chunk via a queue.
export const maxDuration = 60;

// Minimum gap between digests for the same user. 6 days (not 7) so a
// cron that fires Friday 09:00 UTC one week and Friday 08:55 UTC the
// next still goes out — leaves ~5min slack for clock drift / retry.
const MIN_GAP_MS = 6 * 24 * 60 * 60 * 1000;

export async function GET(req: Request) {
  // Authenticate — Vercel Cron sends Authorization: Bearer <CRON_SECRET>
  // when CRON_SECRET is configured in project env. Manual triggers must
  // include the same header.
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured on server" },
      { status: 500 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const sb = createAdminClient();
  const base = appBaseUrl();

  // Pull opt-ins. We resolve email + username via a separate admin call
  // because email lives on auth.users (not the public profiles table)
  // and the join shape from Supabase is awkward without an explicit RPC.
  const { data: prefs, error } = await sb
    .from("email_preferences")
    .select("user_id, unsubscribe_token, last_digest_sent_at")
    .eq("weekly_digest_opted_in", true);
  if (error) {
    return NextResponse.json(
      { error: `Loading email_preferences: ${error.message}` },
      { status: 500 },
    );
  }

  const now = Date.now();
  let sent = 0;
  let skippedRecent = 0;
  let skippedNoLeagues = 0;
  const errors: { userId: string; error: string }[] = [];

  for (const pref of prefs ?? []) {
    const userId = pref.user_id as string;
    const token = pref.unsubscribe_token as string;
    const lastSent = pref.last_digest_sent_at as string | null;

    if (lastSent && now - new Date(lastSent).getTime() < MIN_GAP_MS) {
      skippedRecent++;
      continue;
    }

    try {
      // Pull the auth.users row for email + the profile for username.
      // admin.getUserById returns email; profiles row has the handle.
      const [{ data: userRes }, { data: profile }] = await Promise.all([
        sb.auth.admin.getUserById(userId),
        sb
          .from("profiles")
          .select("username, display_name")
          .eq("user_id", userId)
          .maybeSingle(),
      ]);
      const email = userRes.user?.email ?? null;
      const username = (profile?.username as string | null) ?? null;
      if (!email || !username) {
        errors.push({ userId, error: "Missing email or username" });
        continue;
      }

      const { leagues } = await loadDigestLeagues(sb, { userId, username });
      if (leagues.length === 0) {
        // We still send if they opted in but have no matched leagues —
        // the digest body explains the empty state and links back. But
        // that's a quiet first-week experience, not an error.
        skippedNoLeagues++;
        // Don't actually send empty digests — bounces hurt sender rep.
        // Mark the timestamp so we don't loop on this user every cron.
        await sb
          .from("email_preferences")
          .update({ last_digest_sent_at: new Date().toISOString() })
          .eq("user_id", userId);
        continue;
      }

      const unsubscribeUrl = `${base}/email/unsubscribe?token=${token}`;
      const digest = buildWeeklyDigest({
        email,
        username: (profile?.display_name as string | null) ?? username,
        leagues,
        appBaseUrl: base,
        unsubscribeUrl,
      });

      const result = await sendEmail({
        to: email,
        subject: digest.subject,
        html: digest.html,
        text: digest.text,
        unsubscribeUrl,
      });
      if (!result.ok) {
        errors.push({ userId, error: result.error });
        continue;
      }

      // Mark sent. Failure to update isn't fatal — the next cron will
      // see the stale timestamp and try again, which is fine because
      // Resend is idempotent on our side (we'd just send a 2nd copy).
      // We log it so we can investigate.
      const { error: updErr } = await sb
        .from("email_preferences")
        .update({ last_digest_sent_at: new Date().toISOString() })
        .eq("user_id", userId);
      if (updErr) {
        errors.push({
          userId,
          error: `Sent but failed to update timestamp: ${updErr.message}`,
        });
      }
      sent++;
    } catch (e) {
      errors.push({
        userId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return NextResponse.json({
    ok: true,
    summary: {
      candidates: prefs?.length ?? 0,
      sent,
      skippedRecent,
      skippedNoLeagues,
      errorCount: errors.length,
    },
    errors,
  });
}
