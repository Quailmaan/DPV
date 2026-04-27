// Spot-check the landing-spot analyzer on real DB rows. Pick a few known
// 2024/2025 rookies — different positions, capital, depth-chart contexts —
// and print the bullets that come out.

import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import {
  analyzeLandingSpot,
  summarizeLandingSpot,
  type LandingSpotInput,
} from "../src/lib/dpv/landingSpot";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

const TARGETS = [
  // Mix of recent rookies across positions, capital tiers, and team contexts.
  "Marvin Harrison",
  "Brock Bowers",
  "Caleb Williams",
  "Jonathon Brooks",
  "Ashton Jeanty",
  "Travis Hunter",
  "Cam Ward",
  "Brian Thomas",
];

async function analyzeOne(name: string) {
  const { data: matches } = await sb
    .from("players")
    .select(
      "player_id, name, position, current_team, draft_round, draft_year, birthdate",
    )
    .ilike("name", `${name}%`);
  if (!matches || matches.length === 0) {
    console.log(`\n=== ${name} === (not found)`);
    return;
  }
  // Prefer the rookie record (latest draft_year)
  const player = matches.sort(
    (a, b) => (b.draft_year ?? 0) - (a.draft_year ?? 0),
  )[0];

  const age = player.birthdate
    ? (Date.now() - new Date(player.birthdate).getTime()) /
      (365.25 * 24 * 3600 * 1000)
    : null;

  const [{ data: seasons }, { data: teamRows }, { data: dpvRows }] =
    await Promise.all([
      sb
        .from("player_seasons")
        .select("season, games_played")
        .eq("player_id", player.player_id),
      player.current_team
        ? sb
            .from("team_seasons")
            .select("season, oline_composite_rank, qb_tier")
            .eq("team", player.current_team)
            .order("season", { ascending: false })
            .limit(1)
        : Promise.resolve({ data: [] as Array<unknown> }),
      sb
        .from("dpv_snapshots")
        .select(
          "player_id, dpv, players!inner(name, position, current_team, birthdate)",
        )
        .eq("scoring_format", "HALF_PPR")
        .eq("players.position", player.position),
    ]);

  const hasQ = (seasons ?? []).some((s) => (s.games_played ?? 0) >= 7);
  type Row = {
    player_id: string;
    dpv: number;
    players: {
      name: string;
      position: string;
      current_team: string | null;
      birthdate: string | null;
    };
  };
  const teammates = ((dpvRows ?? []) as unknown as Row[])
    .filter(
      (r) =>
        r.player_id !== player.player_id &&
        r.players.current_team === player.current_team,
    )
    .map((r) => ({
      name: r.players.name,
      age: r.players.birthdate
        ? (Date.now() - new Date(r.players.birthdate).getTime()) /
          (365.25 * 24 * 3600 * 1000)
        : null,
      dpv: r.dpv,
    }))
    .sort((a, b) => b.dpv - a.dpv);

  const ts = (teamRows ?? [])[0] as
    | { oline_composite_rank: number | null; qb_tier: number | null }
    | undefined;

  const input: LandingSpotInput = {
    position: player.position,
    team: player.current_team ?? null,
    draftRound: player.draft_round ?? null,
    draftYear: player.draft_year ?? null,
    age,
    teammates,
    teamContext: ts
      ? { olineRank: ts.oline_composite_rank, qbTier: ts.qb_tier }
      : null,
    isRookieProfile: !hasQ,
  };

  const bullets = analyzeLandingSpot(input);
  const summary = summarizeLandingSpot(bullets);

  console.log(
    `\n=== ${player.name} (${player.position}, ${player.current_team ?? "—"}, R${player.draft_round ?? "?"} ${player.draft_year ?? "?"}, age ${age?.toFixed(1) ?? "?"}, rookie=${!hasQ}) ===`,
  );
  console.log(
    `   teammates(top3 same-pos): ${teammates
      .slice(0, 3)
      .map(
        (t) =>
          `${t.name} (${t.dpv}, age ${t.age?.toFixed(1) ?? "?"})`,
      )
      .join("; ")}`,
  );
  console.log(
    `   teamCtx: oline=${ts?.oline_composite_rank ?? "?"}, qbTier=${ts?.qb_tier ?? "?"}`,
  );
  if (summary) console.log(`   SUMMARY: ${summary.label} (${summary.tone})`);
  for (const b of bullets.sort((a, b) => b.weight - a.weight)) {
    console.log(`   [${b.tone.padEnd(7)}] (w${b.weight}) ${b.title} — ${b.detail}`);
  }
}

(async () => {
  for (const name of TARGETS) {
    await analyzeOne(name);
  }
})();
