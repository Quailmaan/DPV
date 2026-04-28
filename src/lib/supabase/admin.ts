import { createClient } from "@supabase/supabase-js";

// Server-only Supabase client using the service role / secret key. Bypasses
// RLS — never import this from a Client Component or expose its key. Used
// for admin-only operations like seeding the admin user, deleting other
// users' rows, or any backend job that needs to write across every user.
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SECRET_KEY",
    );
  }
  return createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
