import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

(async () => {
  const names = ["Ja'Marr Chase", "Breece Hall", "Brock Purdy", "Bijan Robinson"];
  for (const name of names) {
    const { data: p } = await sb
      .from("players")
      .select("player_id, name, position")
      .ilike("name", name)
      .limit(1)
      .maybeSingle();
    if (!p) {
      console.log(name, "not found");
      continue;
    }
    const { data: h } = await sb
      .from("hsm_comps")
      .select("summary, comps")
      .eq("player_id", p.player_id)
      .maybeSingle();
    if (!h) {
      console.log(name, "no hsm");
      continue;
    }
    console.log("\n===", p.name, p.position, "===");
    // Pull anchor season/PPG from the player_seasons row
    const { data: ps } = await sb
      .from("player_seasons")
      .select("season, games_played, weekly_fantasy_points_half")
      .eq("player_id", p.player_id)
      .order("season", { ascending: false })
      .limit(3);
    for (const s of ps ?? []) {
      const pts = (s.weekly_fantasy_points_half as number[]) ?? [];
      const ppg = pts.length ? pts.reduce((a, b) => a + b, 0) / pts.length : null;
      console.log(
        `  season ${s.season}: gp=${s.games_played}, ppg=${ppg?.toFixed(1) ?? "—"}`,
      );
    }
    console.log("  proj1/2/3:", h.summary.proj1, h.summary.proj2, h.summary.proj3);
    console.log("  blended projectedPPG:", h.summary.projectedPPG);
    console.log("  n1/n2/n3:", h.summary.n1, h.summary.n2, h.summary.n3);
    console.log("  top 5 comps:");
    for (const c of h.comps.slice(0, 5)) {
      console.log(
        `    ${c.name} (${c.anchorSeason}, age ${c.anchorAge}, ${c.anchorPPG}ppg) sim=${c.similarity} → Y1=${c.nextPPG1} Y2=${c.nextPPG2} Y3=${c.nextPPG3}`,
      );
    }
  }
})();
