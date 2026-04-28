// Shared gate for the CSV export endpoints. Three checks in order:
//   1. Signed in (the middleware already redirects guests away from
//      non-public routes, but a JSON 401 here is still useful for
//      anyone hitting the URL via fetch / curl with no cookie).
//   2. Pro tier — the export feature is the only thing actually
//      paywalled at the route level. Free users hit a 402 with a JSON
//      error so the front-end can hide the buttons but a hand-typed URL
//      gets a clean message instead of an empty CSV.
//   3. Owns the league (or is admin). Mirrors the gate on
//      /league/[id] — RLS would also enforce it via user_leagues
//      visibility, but checking explicitly lets us return 404 instead
//      of 200 with empty data.

import { getCurrentSession, type SessionProfile } from "@/lib/auth/session";
import { getCurrentTier } from "@/lib/billing/tier";
import { createServerClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

export type ExportGuardOk = {
  ok: true;
  sb: SupabaseClient;
  session: SessionProfile;
};
export type ExportGuardFail = { ok: false; response: Response };

export async function guardExport(
  leagueId: string,
): Promise<ExportGuardOk | ExportGuardFail> {
  const session = await getCurrentSession();
  if (!session) {
    return {
      ok: false,
      response: Response.json({ error: "Sign in required." }, { status: 401 }),
    };
  }

  const tier = await getCurrentTier();
  if (tier.tier !== "pro") {
    return {
      ok: false,
      response: Response.json(
        { error: "CSV export is a Pro feature. Upgrade at /pricing." },
        { status: 402 },
      ),
    };
  }

  const sb = await createServerClient();
  // Admins can export any league for support / debugging — mirrors the
  // page-level admin bypass.
  if (!session.isAdmin) {
    const { data: link } = await sb
      .from("user_leagues")
      .select("league_id")
      .eq("league_id", leagueId)
      .maybeSingle();
    if (!link) {
      return {
        ok: false,
        response: Response.json({ error: "League not found." }, { status: 404 }),
      };
    }
  }
  return { ok: true, sb, session };
}
