"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { createServerClient } from "@/lib/supabase/server";
import { readSubscriptionState } from "@/lib/billing/tier";
import { syncSleeperLeague } from "@/lib/sleeper/sync";

export type SyncFormState = {
  error?: string;
};

// Free tier ceiling. Pro is uncapped — the DB trigger
// (enforce_user_league_cap) is the hard guarantee, this constant just
// drives the friendlier client-side error path.
const FREE_LEAGUE_CAP = 1;

export async function syncLeagueAction(
  _prev: SyncFormState,
  form: FormData,
): Promise<SyncFormState> {
  const session = await requireSession("/login?next=/league");
  const raw = form.get("league_id");
  const leagueId = typeof raw === "string" ? raw.trim() : "";
  if (!leagueId) {
    return { error: "Enter a Sleeper league ID." };
  }

  const sb = await createServerClient();

  // Resolve the user's tier so the cap math is correct. Pro is
  // uncapped; free is FREE_LEAGUE_CAP. The DB trigger enforces the
  // same rule — this is the friendly preflight path.
  const tierState = await readSubscriptionState(sb, session.userId);
  const isPro = tierState.tier === "pro";

  // Cap check before doing the sync work — bail out cleanly when at limit.
  // RLS scopes user_leagues to the current user, so this counts only
  // theirs. The DB trigger is the hard guarantee; this is just a nicer
  // error path that avoids paying for the Sleeper API roundtrip.
  const { count, error: countError } = await sb
    .from("user_leagues")
    .select("league_id", { count: "exact", head: true });
  if (countError) {
    return { error: countError.message };
  }
  // If the user already has this league, treat it as a re-sync (no cap
  // bump). Otherwise enforce the cap.
  const { data: existing } = await sb
    .from("user_leagues")
    .select("league_id")
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!existing && !isPro && (count ?? 0) >= FREE_LEAGUE_CAP) {
    return {
      error: `Free accounts are limited to ${FREE_LEAGUE_CAP} league. Upgrade to Pro for unlimited leagues, or remove your existing league first.`,
    };
  }

  try {
    const result = await syncSleeperLeague(leagueId);

    // Link the league to the signed-in user. The shared `leagues` table
    // already got the upsert from syncSleeperLeague — we just record that
    // THIS user wants to see it.
    const { error: linkError } = await sb
      .from("user_leagues")
      .upsert(
        { user_id: session.userId, league_id: result.leagueId },
        { onConflict: "user_id,league_id" },
      );
    if (linkError) {
      // The DB trigger raises this when the cap is hit. Surface a
      // friendly message instead of the raw Postgres exception text.
      // The trigger reads tier from the subscriptions table, so this
      // path only fires for free users at the FREE_LEAGUE_CAP limit.
      if (linkError.message.includes("user_leagues_cap_exceeded")) {
        return {
          error: `Free accounts are limited to ${FREE_LEAGUE_CAP} league. Upgrade to Pro for unlimited leagues.`,
        };
      }
      return { error: linkError.message };
    }

    revalidatePath("/league");
    revalidatePath(`/league/${result.leagueId}`);
    // ?pick=1 surfaces the team picker banner on first sync. The page
    // also shows the picker whenever roster_id is null, so users who
    // navigate away without picking can still complete it later.
    redirect(`/league/${result.leagueId}?pick=1`);
  } catch (e) {
    if (
      e &&
      typeof e === "object" &&
      "digest" in e &&
      typeof (e as { digest?: string }).digest === "string" &&
      (e as { digest: string }).digest.startsWith("NEXT_REDIRECT")
    ) {
      throw e;
    }
    return {
      error: e instanceof Error ? e.message : "Sync failed.",
    };
  }
  return {};
}

// Re-run the Sleeper sync for a league the user already has linked. This is
// the "refresh" path — picks up roster moves, traded picks, etc. without
// adding a new row to user_leagues (so the cap is unaffected). Verifies the
// user owns the league first so a hand-crafted form post can't trigger
// syncs against arbitrary leagues.
export async function resyncLeagueAction(formData: FormData): Promise<void> {
  const session = await requireSession("/login?next=/league");
  const leagueId = String(formData.get("league_id") ?? "").trim();
  if (!leagueId) return;

  const sb = await createServerClient();
  const { data: link } = await sb
    .from("user_leagues")
    .select("league_id")
    .eq("user_id", session.userId)
    .eq("league_id", leagueId)
    .maybeSingle();
  if (!link) return;

  await syncSleeperLeague(leagueId);
  revalidatePath("/league");
  revalidatePath(`/league/${leagueId}`);
}

// Persist "which roster in this league is mine." Reading null on a
// user_leagues row means the user hasn't picked yet — the league page
// surfaces a dropdown banner, and the digest skips the league rather
// than guess.
//
// Two-phase design (sync first, pick after) keeps the sync action fast
// and stops us blocking the redirect on Sleeper roster shape parsing.
// Users can also re-pick if they ever change Sleeper teams — same form,
// same action.
export async function setMyTeamAction(formData: FormData): Promise<void> {
  const session = await requireSession("/login?next=/league");
  const leagueId = String(formData.get("league_id") ?? "").trim();
  const rosterIdRaw = String(formData.get("roster_id") ?? "").trim();
  if (!leagueId || !rosterIdRaw) return;
  const rosterId = Number.parseInt(rosterIdRaw, 10);
  if (!Number.isFinite(rosterId)) return;

  const sb = await createServerClient();

  // Validate the roster exists in the league before saving — protects
  // against a hand-crafted form post setting a bogus roster_id that
  // would later cause the focused-team views to render empty.
  const { data: roster } = await sb
    .from("league_rosters")
    .select("roster_id")
    .eq("league_id", leagueId)
    .eq("roster_id", rosterId)
    .maybeSingle();
  if (!roster) return;

  // RLS limits the update to the user's own row.
  await sb
    .from("user_leagues")
    .update({ roster_id: rosterId })
    .eq("user_id", session.userId)
    .eq("league_id", leagueId);

  revalidatePath("/league");
  revalidatePath(`/league/${leagueId}`);
  redirect(`/league/${leagueId}`);
}

export async function removeLeagueAction(formData: FormData): Promise<void> {
  const session = await requireSession("/login?next=/league");
  const leagueId = String(formData.get("league_id") ?? "").trim();
  if (!leagueId) return;

  const sb = await createServerClient();
  // RLS already restricts to the user's rows but the explicit user_id
  // filter is belt-and-suspenders.
  await sb
    .from("user_leagues")
    .delete()
    .eq("user_id", session.userId)
    .eq("league_id", leagueId);

  revalidatePath("/league");
}
