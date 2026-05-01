/**
 * Two utilities for the weekly digest in one script:
 *
 *   npx tsx scripts/digest-check.ts                   # diagnostic
 *     Prints every email_preferences row so you can see who's
 *     opted in, when they last received a digest, and whether
 *     their state explains a missing email.
 *
 *   npx tsx scripts/digest-check.ts --send            # manual fire
 *     Hits /api/cron/weekly-digest on the deployed site with
 *     CRON_SECRET as the bearer token and prints the JSON
 *     summary the route returns. Use to test outside of
 *     Friday 14:00 UTC, or to retry after fixing an opt-in.
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY!;
const CRON_SECRET = process.env.CRON_SECRET;
// Production domain by default. Override for staging or to test
// against a localhost dev server with `DIGEST_BASE=http://localhost:3000`.
const BASE = process.env.DIGEST_BASE ?? "https://www.pylonff.com";

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.error("Missing Supabase env vars (.env.local)");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

async function diagnose() {
  console.log(`Diagnosing digest state on ${BASE}\n`);

  const { data: prefs, error } = await sb
    .from("email_preferences")
    .select("user_id, weekly_digest_opted_in, last_digest_sent_at");
  if (error) throw error;

  const optedIn = (prefs ?? []).filter((p) => p.weekly_digest_opted_in);
  console.log(`email_preferences rows: ${prefs?.length ?? 0} total`);
  console.log(`  opted-in: ${optedIn.length}`);
  console.log(
    `  opted-out / null: ${(prefs?.length ?? 0) - optedIn.length}\n`,
  );

  if (optedIn.length === 0) {
    console.log("No users opted in — nothing for the cron to send.");
    console.log("Toggle weekly_digest_opted_in=true on your account.");
    return;
  }

  // For each opted-in user, resolve email + username + league count
  // so we can flag the three states the cron route distinguishes:
  // (a) eligible to send, (b) skipped recently, (c) opted-in but no leagues.
  const now = Date.now();
  const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
  console.log("Per-user state:");
  for (const p of optedIn) {
    const userId = p.user_id as string;
    const lastSent = p.last_digest_sent_at as string | null;
    const sinceMs = lastSent
      ? now - new Date(lastSent).getTime()
      : Number.POSITIVE_INFINITY;
    const recentlySent = sinceMs < SIX_DAYS_MS;

    const [{ data: userRes }, { data: profile }, { count: leagueCount }] =
      await Promise.all([
        sb.auth.admin.getUserById(userId),
        sb
          .from("profiles")
          .select("username")
          .eq("user_id", userId)
          .maybeSingle(),
        sb
          .from("user_leagues")
          .select("league_id", { count: "exact", head: true })
          .eq("user_id", userId),
      ]);

    const email = userRes.user?.email ?? "(no email)";
    const username = (profile?.username as string | null) ?? "(no username)";
    const sinceLabel = lastSent
      ? `${Math.round(sinceMs / (24 * 3600 * 1000))}d ago`
      : "never";
    const flag = recentlySent
      ? "SKIP recent"
      : (leagueCount ?? 0) === 0
        ? "SKIP no leagues"
        : "ELIGIBLE";
    console.log(
      `  ${flag.padEnd(15)} @${username.padEnd(20)} ${email.padEnd(32)} last=${sinceLabel} leagues=${leagueCount ?? 0}`,
    );
  }

  console.log("");
  console.log(
    `Run with --send to manually fire the digest now (uses CRON_SECRET).`,
  );
}

async function manualSend() {
  if (!CRON_SECRET) {
    console.error(
      "CRON_SECRET not set in .env.local — same value as the Vercel project env.",
    );
    process.exit(1);
  }
  const url = `${BASE}/api/cron/weekly-digest`;
  console.log(`POST → ${url}\n`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  try {
    const json = JSON.parse(text);
    console.log(JSON.stringify(json, null, 2));
  } catch {
    console.log(text);
  }
}

const send = process.argv.includes("--send");
(send ? manualSend() : diagnose()).catch((e) => {
  console.error(e);
  process.exit(1);
});
