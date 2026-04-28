import { createServerClient as createSupabaseServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

// SSR-aware Supabase server client. Reads/writes the auth session cookies
// via Next's cookie store so RLS policies that gate on auth.uid() see the
// signed-in user. Now async because next/headers cookies() is async in
// Next 15+. Every server-side caller must `await createServerClient()`.
export async function createServerClient() {
  const cookieStore = await cookies();
  return createSupabaseServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // setAll() can be called from a Server Component, where cookie
          // writes are not allowed. Middleware refreshes the session on
          // every request so this is safe to swallow.
        }
      },
    },
  });
}
