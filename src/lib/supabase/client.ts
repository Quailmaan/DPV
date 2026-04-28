import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !publishableKey) {
  throw new Error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  );
}

// Browser-side Supabase client. Persists the auth session in cookies so
// the SSR client can read it. Use this only in Client Components.
export function createBrowserSupabase() {
  return createBrowserClient(supabaseUrl!, publishableKey!);
}

// Back-compat singleton for existing read-only client-side queries that
// don't care about auth state.
export const supabase = createBrowserSupabase();
