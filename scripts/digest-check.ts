/**
 * Five utilities for the weekly digest in one script:
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
 *
 *   npx tsx scripts/digest-check.ts --reset @username # clear one user
 *     Nulls last_digest_sent_at for that user so the next --send
 *     (or the next cron) ignores the 6-day idempotency window.
 *
 *   npx tsx scripts/digest-check.ts --reset-all       # clear everyone
 *     Same idea but applied to every opted-in user. Use after a
 *     copy-fix or template change when you want all subscribers
 *     to receive the updated email immediately. Pair with --send
 *     (or click Run Now in Vercel) to actually fire the digests.
 *     Safe to re-run — worst case is one duplicate email per user.
 *
 *   npx tsx scripts/digest-check.ts --preview @username > preview.html
 *     Loads the digest data for that user, builds the email HTML
 *     locally, and writes it to stdout. Pipe to a file and open in
 *     a browser to see EXACTLY what gets generated, bypassing all
 *     email-client rendering quirks (Gmail "trimmed content" collapse,
 *     Outlook CSS pruning, etc.). Useful for debugging missing-section
 *     reports — if a section is in preview.html, the bug is the
 *     client; if it's missing here, the bug is in our render.
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

async function resetUser() {
  const idx = process.argv.indexOf("--reset");
  const handle = process.argv[idx + 1];
  if (!handle || handle.startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/digest-check.ts --reset @username",
    );
    process.exit(1);
  }
  const cleanHandle = handle.replace(/^@/, "");
  const { data: profile, error: profileErr } = await sb
    .from("profiles")
    .select("user_id, username")
    .ilike("username", cleanHandle)
    .maybeSingle();
  if (profileErr) throw profileErr;
  if (!profile) {
    console.error(`No profile found for "${cleanHandle}"`);
    process.exit(1);
  }
  const userId = profile.user_id as string;
  const { error: updErr } = await sb
    .from("email_preferences")
    .update({ last_digest_sent_at: null })
    .eq("user_id", userId);
  if (updErr) throw updErr;
  console.log(
    `Cleared last_digest_sent_at for @${profile.username} (${userId})`,
  );
  console.log(
    "Run with --send next to fire the digest now, or wait for Friday 14:00 UTC.",
  );
}

async function preview() {
  // Lazy-import so the diagnostic / send / reset paths don't pay
  // the cost of pulling in the digest-data + html-builder modules
  // (and their transitive deps) on every invocation.
  const { loadDigestLeagues } = await import("../src/lib/email/digestData");
  const { buildWeeklyDigest } = await import("../src/lib/email/weeklyDigest");

  const idx = process.argv.indexOf("--preview");
  const handle = process.argv[idx + 1];
  if (!handle || handle.startsWith("--")) {
    console.error(
      "Usage: npx tsx scripts/digest-check.ts --preview @username",
    );
    process.exit(1);
  }
  const cleanHandle = handle.replace(/^@/, "");
  const { data: profile } = await sb
    .from("profiles")
    .select("user_id, username, display_name")
    .ilike("username", cleanHandle)
    .maybeSingle();
  if (!profile) {
    console.error(`No profile found for "${cleanHandle}"`);
    process.exit(1);
  }
  const userId = profile.user_id as string;
  const username = profile.username as string;

  const { data: userRes } = await sb.auth.admin.getUserById(userId);
  const email = userRes.user?.email ?? "preview@example.com";

  const { leagues, skippedLeagues } = await loadDigestLeagues(sb, {
    userId,
    username,
  });

  // Stderr so it doesn't pollute the HTML on stdout when piping.
  console.error(
    `Loaded ${leagues.length} leagues for @${username} (skipped ${skippedLeagues.length}).`,
  );
  if (skippedLeagues.length > 0) {
    for (const s of skippedLeagues) {
      console.error(`  skipped ${s.leagueName}: ${s.reason}`);
    }
  }

  // Show what fields are present per league — quick sanity check
  // that's faster than scrolling the HTML for a missing section.
  for (const l of leagues) {
    console.error(`\n[${l.leagueName}]`);
    console.error(`  card:        ${JSON.stringify(l.card)} rank=${l.cardRank}`);
    console.error(
      `  strongest:   ${l.strongest ? `${l.strongest.position} #${l.strongest.rank}/${l.strongest.totalRosters} (${l.strongest.deltaPct}%)` : "MISSING"}`,
    );
    console.error(
      `  weakest:     ${l.weakest ? `${l.weakest.position} #${l.weakest.rank}/${l.weakest.totalRosters} (${l.weakest.deltaPct}%)` : "MISSING"}`,
    );
    console.error(
      `  topRisers:   ${l.topRisers?.length ?? 0} entries`,
    );
    console.error(
      `  topFallers:  ${l.topFallers?.length ?? 0} entries`,
    );
    console.error(
      `  partners:    ${l.tradePartners?.length ?? 0} entries`,
    );
    console.error(
      `  biggestTrade: ${l.biggestTrade ? `winner @${l.biggestTrade.winnerOwner} (+${l.biggestTrade.winnerNetPyv})` : "null"}`,
    );
    console.error(
      `  leagueLoser: ${l.leagueLoser ? `${l.leagueLoser.name} ${l.leagueLoser.delta}` : "null"}`,
    );
    console.error(`  topSells:    ${l.topSells.length} entries`);
  }

  const digest = buildWeeklyDigest({
    email,
    username: (profile.display_name as string | null) ?? username,
    leagues,
    appBaseUrl: BASE,
    unsubscribeUrl: `${BASE}/email/unsubscribe?token=preview`,
  });

  // Print just the html to stdout (the meaningful render output).
  process.stdout.write(digest.html);
}

async function resetAll() {
  // Pull the opted-in user list first so we can report names + count.
  // Acts as a confirmation: caller sees what they're about to clear.
  const { data: prefs, error } = await sb
    .from("email_preferences")
    .select("user_id, last_digest_sent_at")
    .eq("weekly_digest_opted_in", true);
  if (error) throw error;
  const optedIn = (prefs ?? []) as {
    user_id: string;
    last_digest_sent_at: string | null;
  }[];
  if (optedIn.length === 0) {
    console.log("No opted-in users — nothing to reset.");
    return;
  }
  console.log(`Clearing last_digest_sent_at for ${optedIn.length} opted-in users...`);
  const { error: updErr } = await sb
    .from("email_preferences")
    .update({ last_digest_sent_at: null })
    .eq("weekly_digest_opted_in", true);
  if (updErr) throw updErr;
  console.log(`  Done. Run --send (or click Run Now in Vercel) to fire fresh digests to all.`);
}

const resetAllFlag = process.argv.includes("--reset-all");
const reset = process.argv.includes("--reset");
const send = process.argv.includes("--send");
const previewFlag = process.argv.includes("--preview");
const action = previewFlag
  ? preview()
  : resetAllFlag
    ? resetAll()
    : reset
      ? resetUser()
      : send
        ? manualSend()
        : diagnose();
action.catch((e) => {
  console.error(e);
  process.exit(1);
});
