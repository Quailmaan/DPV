import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export function createServerClient() {
  return createClient(url, anonKey, {
    auth: { persistSession: false },
    global: { fetch: (...args) => fetch(...args) },
  });
}
