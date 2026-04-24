import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

(async () => {
  // Pick a handful of 2024/2025 class rookies and veterans to verify the
  // combine mult is flowing through rookie priors.
  const names = [
    "Jonathon Brooks",
    "MarShawn Lloyd",
    "Caleb Williams",
    "Rome Odunze",
    "Marvin Harrison",
    "Drake Maye",
    "Jayden Daniels",
  ];
  for (const name of names) {
    const { data: p } = await sb
      .from("players")
      .select("player_id, name, position, current_team, draft_year, draft_round")
      .ilike("name", name)
      .maybeSingle();
    if (!p) {
      console.log(`${name}: not found`);
      continue;
    }
    const { data: combine } = await sb
      .from("combine_stats")
      .select("athleticism_score, forty, vertical, broad_jump, metrics_count")
      .eq("player_id", p.player_id)
      .maybeSingle();
    const { data: snap } = await sb
      .from("dpv_snapshots")
      .select("dpv, tier, breakdown")
      .eq("player_id", p.player_id)
      .eq("scoring_format", "HALF_PPR")
      .maybeSingle();
    console.log(`\n${p.name} (${p.position}, ${p.current_team}, '${p.draft_year} R${p.draft_round})`);
    if (combine) {
      console.log(
        `  combine: RAS=${combine.athleticism_score?.toFixed(1)}  40=${combine.forty}  vert=${combine.vertical}  broad=${combine.broad_jump}  (n=${combine.metrics_count})`,
      );
    } else {
      console.log(`  combine: (no data)`);
    }
    if (snap) {
      console.log(`  DPV=${snap.dpv} — ${snap.tier}`);
      const b = snap.breakdown as Record<string, unknown>;
      if (b.kind === "rookie_prior") {
        console.log(
          `  breakdown: base=${b.base} oLine=${b.oLineMult} qbTier=${b.qbTierMult} age=${b.ageMult} fmt=${b.formatMult} lapse=${b.lapseMult} intra=${b.intraClassDepthMult} displace=${b.rookieDisplacementMult} combine=${b.combineMult} hsm=${b.hsmMult} (RAS=${b.athleticismScore} hsmPPG=${b.hsmProjectedPPG} n=${b.hsmN} w=${b.hsmWeight} preHSM=${b.preHsmDPV})`,
        );
      } else {
        console.log(`  (veteran breakdown — combine doesn't apply)`);
      }
    } else {
      console.log(`  no DPV snapshot`);
    }
  }
})();
