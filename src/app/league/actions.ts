"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { syncSleeperLeague } from "@/lib/sleeper/sync";

export type SyncFormState = {
  error?: string;
};

export async function syncLeagueAction(
  _prev: SyncFormState,
  form: FormData,
): Promise<SyncFormState> {
  const raw = form.get("league_id");
  const leagueId = typeof raw === "string" ? raw.trim() : "";
  if (!leagueId) {
    return { error: "Enter a Sleeper league ID." };
  }
  try {
    const result = await syncSleeperLeague(leagueId);
    revalidatePath("/league");
    revalidatePath(`/league/${result.leagueId}`);
    redirect(`/league/${result.leagueId}`);
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
