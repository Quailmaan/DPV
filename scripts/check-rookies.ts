/**
 * Diagnose why freshly-drafted rookies aren't getting PYV snapshots.
 *
 * The rookie-prior path in compute-dpv only fires for players that
 * have a row in the `players` table. `players` is built from nflverse
 * ROSTER files (roster_<year>.parquet), which can lag the draft by
 * days — the just-drafted class is in draft_picks.csv immediately but
 * may not be in the roster file yet. This script checks where the
 * 2026 class actually is across our tables + the raw nflverse source.
 *
 * Run: npx tsx scripts/check-rookies.ts
 */
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { persistSession: false } },
);

const DRAFT_YEAR = 2026;
const NFLVERSE_DRAFT =
  "https://github.com/nflverse/nflverse-data/releases/download/draft_picks/draft_picks.csv";

async function fetchAll<T>(
  table: string,
  columns: string,
  filter?: (q: ReturnType<ReturnType<typeof sb.from>["select"]>) => unknown,
): Promise<T[]> {
  const out: T[] = [];
  const PAGE = 1000;
  let start = 0;
  while (true) {
    let q = sb.from(table).select(columns) as ReturnType<
      ReturnType<typeof sb.from>["select"]
    >;
    if (filter) q = filter(q) as typeof q;
    const { data, error } = await q.range(start, start + PAGE - 1);
    if (error) throw error;
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

async function main() {
  console.log(`Diagnosing ${DRAFT_YEAR} rookie class\n`);

  // 1. players table: how many draft_year=2026, and do they have the
  //    fields compute-dpv needs (birthdate for age, draft_round)?
  const players = await fetchAll<{
    player_id: string;
    name: string;
    position: string;
    birthdate: string | null;
    draft_round: number | null;
    draft_year: number | null;
    current_team: string | null;
  }>("players", "player_id,name,position,birthdate,draft_round,draft_year,current_team");

  const draftClass = players.filter((p) => p.draft_year === DRAFT_YEAR);
  const skillClass = draftClass.filter((p) =>
    ["QB", "RB", "WR", "TE"].includes(p.position),
  );
  console.log(`players table:`);
  console.log(`  ${players.length} total players`);
  console.log(`  ${draftClass.length} with draft_year=${DRAFT_YEAR}`);
  console.log(`  ${skillClass.length} of those at QB/RB/WR/TE`);
  console.log(
    `    with birthdate: ${skillClass.filter((p) => p.birthdate).length}`,
  );
  console.log(
    `    with draft_round: ${skillClass.filter((p) => p.draft_round !== null).length}`,
  );
  // Spot-check a few well-known names
  const probe = ["Mendoza", "Love", "Tate", "Tyson", "Simpson"];
  console.log(`  name probes:`);
  for (const needle of probe) {
    const hits = players.filter((p) =>
      p.name.toLowerCase().includes(needle.toLowerCase()),
    );
    const recent = hits.filter((h) => (h.draft_year ?? 0) >= DRAFT_YEAR - 1);
    console.log(
      `    "${needle}": ${hits.length} total, ${recent.length} recent — ${recent
        .map(
          (h) =>
            `${h.name}(${h.position},dy=${h.draft_year},rd=${h.draft_round},bd=${h.birthdate ? "y" : "n"})`,
        )
        .join("; ")}`,
    );
  }

  // 2. prospect_consensus: do we have the 2026 names there?
  const consensus = await fetchAll<{ name: string; draft_year: number | null }>(
    "prospect_consensus",
    "name,draft_year",
  );
  const consensus2026 = consensus.filter((c) => c.draft_year === DRAFT_YEAR);
  console.log(`\nprospect_consensus:`);
  console.log(`  ${consensus2026.length} rows for ${DRAFT_YEAR}`);

  // 3. dpv_snapshots: did ANY 2026 rookie get a snapshot?
  const skillIds = new Set(skillClass.map((p) => p.player_id));
  if (skillIds.size > 0) {
    const snaps = await fetchAll<{ player_id: string }>(
      "dpv_snapshots",
      "player_id",
      (q) =>
        (q as ReturnType<ReturnType<typeof sb.from>["select"]>).eq(
          "scoring_format",
          "HALF_PPR",
        ),
    );
    const snapIds = new Set(snaps.map((s) => s.player_id));
    const rookiesWithSnap = [...skillIds].filter((id) => snapIds.has(id));
    console.log(`\ndpv_snapshots (HALF_PPR):`);
    console.log(
      `  ${rookiesWithSnap.length}/${skillIds.size} of the ${DRAFT_YEAR} skill class have a snapshot`,
    );
  }

  // 4. Raw nflverse draft_picks.csv: does it have the class + ages?
  console.log(`\nnflverse draft_picks.csv:`);
  const res = await fetch(NFLVERSE_DRAFT);
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const iSeason = header.indexOf("season");
  const iPos = header.indexOf("position");
  const iGsis = header.indexOf("gsis_id");
  const iAge = header.indexOf("age");
  const iName = header.indexOf("pfr_player_name");
  const iRound = header.indexOf("round");
  const iPick = header.indexOf("pick");

  type Pick = {
    name: string;
    pos: string;
    gsis: string | null;
    round: number;
    pick: number;
    hasAge: boolean;
  };
  const picks: Pick[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (parseInt(cols[iSeason], 10) !== DRAFT_YEAR) continue;
    if (!["QB", "RB", "WR", "TE"].includes((cols[iPos] ?? "").trim())) continue;
    const gsisRaw = cols[iGsis];
    picks.push({
      name: (cols[iName] ?? "").trim(),
      pos: (cols[iPos] ?? "").trim(),
      gsis: gsisRaw && gsisRaw !== "NA" && gsisRaw !== "" ? gsisRaw : null,
      round: parseInt(cols[iRound], 10),
      pick: parseInt(cols[iPick], 10),
      hasAge: !!cols[iAge] && cols[iAge] !== "NA" && cols[iAge] !== "",
    });
  }
  const withGsis = picks.filter((p) => p.gsis).length;
  const withAge = picks.filter((p) => p.hasAge).length;
  console.log(
    `  ${picks.length} skill picks; ${withGsis} have gsis_id; ${withAge} have age`,
  );

  // 5. The actual gap: which picks are NOT in dpv_snapshots, and why?
  console.log(`\nMissing-from-rankings report:`);
  const snaps = await fetchAll<{ player_id: string }>(
    "dpv_snapshots",
    "player_id",
    (q) =>
      (q as ReturnType<ReturnType<typeof sb.from>["select"]>).eq(
        "scoring_format",
        "HALF_PPR",
      ),
  );
  const snapIds = new Set(snaps.map((s) => s.player_id));
  const playerIds = new Set(players.map((p) => p.player_id));
  // Build a normalized-name → snapshot presence check for the gsis-less
  // picks (we can still tell if SOME row by that name made it in).
  const playerNamesNorm = new Map<string, string>(); // norm name → player_id
  for (const p of players) {
    playerNamesNorm.set(
      p.name.toLowerCase().replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim(),
      p.player_id,
    );
  }
  const missing: { pick: Pick; reason: string }[] = [];
  for (const p of picks) {
    if (p.gsis && snapIds.has(p.gsis)) continue; // present, good
    let reason: string;
    if (!p.gsis) {
      // Try a name match to see if they slipped in some other way.
      const norm = p.name
        .toLowerCase()
        .replace(/[^a-z ]/g, "")
        .replace(/\s+/g, " ")
        .trim();
      const matchId = playerNamesNorm.get(norm);
      reason =
        matchId && snapIds.has(matchId)
          ? "OK (matched by name, no gsis in CSV)"
          : "NO gsis_id in draft_picks.csv → no players row";
    } else if (!playerIds.has(p.gsis)) {
      reason = "has gsis but no players row (synthesis missed?)";
    } else {
      reason = "in players but no snapshot (compute-dpv skipped — check age/round)";
    }
    if (!reason.startsWith("OK")) missing.push({ pick: p, reason });
  }
  console.log(`  ${missing.length} of ${picks.length} picks missing from snapshots:`);
  for (const m of missing.sort((a, b) => a.pick.pick - b.pick.pick)) {
    console.log(
      `    ${String(m.pick.pick).padStart(3)} R${m.pick.round} ${m.pick.pos.padEnd(3)} ${m.pick.name.padEnd(26)} — ${m.reason}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
