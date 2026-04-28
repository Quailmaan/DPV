// Seed an admin user and pre-link a Sleeper league to them. Idempotent —
// safe to re-run. Pulls credentials from env so they never live in git.
//
// Required env (in .env.local or shell):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SECRET_KEY            (service role key — admin operations)
//   ADMIN_EMAIL                    (e.g. you@example.com)
//   ADMIN_PASSWORD                 (>= 8 chars)
//   ADMIN_USERNAME                 (3-24 chars, [a-zA-Z0-9_])
//   ADMIN_LEAGUE_ID                (Sleeper league_id to attach)
//
// Usage:
//   npx tsx scripts/seed-admin.ts
//
// What it does:
//   1. Creates the auth.users row via Supabase admin API (email already
//      confirmed — no email verification step).
//   2. Updates the auto-created profiles row with the chosen username and
//      flips is_admin = true.
//   3. Runs the regular Sleeper league sync to populate `leagues` and
//      `league_rosters`.
//   4. Inserts the user_leagues link row.

import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();

import { createClient } from "@supabase/supabase-js";
import { syncSleeperLeague } from "../src/lib/sleeper/sync";

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(1);
  }
  return v;
}

async function main() {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const secret = requireEnv("SUPABASE_SECRET_KEY");
  const email = requireEnv("ADMIN_EMAIL").toLowerCase();
  const password = requireEnv("ADMIN_PASSWORD");
  const username = requireEnv("ADMIN_USERNAME");
  const leagueId = requireEnv("ADMIN_LEAGUE_ID");

  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }
  if (!USERNAME_RE.test(username)) {
    console.error(
      "ADMIN_USERNAME must be 3-24 chars of [a-zA-Z0-9_].",
    );
    process.exit(1);
  }

  const admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Create or fetch the auth user. createUser fails if email already
  // exists; we treat that as "already seeded" and look the user up.
  console.log(`Ensuring admin user ${email}...`);
  let userId: string | null = null;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (created.error) {
    if (
      /already (registered|been registered|exists)/i.test(
        created.error.message,
      )
    ) {
      // List + find by email — admin.listUsers doesn't take a filter, but
      // we only have one admin, so paginate the first page.
      const { data: list, error: listErr } = await admin.auth.admin.listUsers({
        page: 1,
        perPage: 200,
      });
      if (listErr) throw listErr;
      const existing = list.users.find(
        (u) => u.email?.toLowerCase() === email,
      );
      if (!existing) {
        throw new Error(
          "auth user reported as existing but not found via listUsers — check pagination",
        );
      }
      userId = existing.id;
      console.log(`  ↺ already existed (${userId})`);
    } else {
      throw created.error;
    }
  } else {
    userId = created.data.user!.id;
    console.log(`  ✓ created (${userId})`);
  }

  if (!userId) throw new Error("Failed to resolve admin user id");

  // 2) Update profile: set username + is_admin. The auth.users insert
  // trigger has already created a placeholder profiles row.
  console.log(`Updating profile (@${username}, is_admin=true)...`);
  const { error: profileError } = await admin
    .from("profiles")
    .update({ username, is_admin: true, display_name: "Admin" })
    .eq("user_id", userId);
  if (profileError) {
    // If the username collides with someone else, that's a real error.
    if (profileError.message.includes("duplicate") || profileError.code === "23505") {
      throw new Error(
        `Username "${username}" is already taken by another account.`,
      );
    }
    throw profileError;
  }
  console.log("  ✓ profile updated");

  // 3) Sync the Sleeper league into the shared leagues table.
  console.log(`Syncing Sleeper league ${leagueId}...`);
  const sync = await syncSleeperLeague(leagueId);
  console.log(
    `  ✓ ${sync.name} (${sync.season}, ${sync.scoringFormat}, ${sync.totalRosters} teams)`,
  );

  // 4) Link the league to the admin user. RLS bypass via the secret key
  // means the trigger's cap check still applies — but the admin should
  // only ever have ≤3 leagues so that's fine.
  console.log("Linking league to admin user...");
  const { error: linkError } = await admin
    .from("user_leagues")
    .upsert(
      { user_id: userId, league_id: sync.leagueId, is_default: true },
      { onConflict: "user_id,league_id" },
    );
  if (linkError) throw linkError;
  console.log("  ✓ linked");

  console.log("\nDone. Sign in at /login with:");
  console.log(`  username: ${username}`);
  console.log(`  email:    ${email}`);
}

main().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
