import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

// Build cross-source prospect consensus from the raw prospects table.
//
// Why rank-based: different sources use different grade scales — KTC is in
// the thousands, NFL scout grades are 60-100, some sites just provide top-N
// rankings. To combine them fairly, we convert each source's grades into
// ranks within the draft_year, average ranks per prospect across sources,
// and map the average rank back to a 0-100 normalized grade via exponential
// decay (rank 1 → 100, rank 10 → ~64, rank 50 → ~8).
//
// A prospect only ranked by one source is still included, with source_count
// = 1 so downstream consumers (class_strength) can weight or filter by
// agreement.

type Row = {
  prospect_id: string;
  source: string;
  draft_year: number;
  name: string;
  position: string | null;
  consensus_grade: number | null;
  projected_round: number | null;
  projected_overall_pick: number | null;
};

// Exponential decay. Tuned so:
//   rank 1  → 100
//   rank 10 → ~64
//   rank 25 → ~29
//   rank 50 → ~8
function rankToGrade(avgRank: number): number {
  return Number((100 * Math.exp(-(avgRank - 1) / 22)).toFixed(2));
}

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await sb.from("prospects").select("*");
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  if (rows.length === 0) {
    console.log("No prospects found.");
    return;
  }

  // Rank within (source, draft_year) by consensus_grade desc. Rows with no
  // grade fall to the bottom but still get ranked so they count toward
  // source_count.
  const bySourceYear = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.source}|${r.draft_year}`;
    const arr = bySourceYear.get(k) ?? [];
    arr.push(r);
    bySourceYear.set(k, arr);
  }

  const ranksByProspect = new Map<string, number[]>();
  const meta = new Map<
    string,
    Pick<Row, "draft_year" | "name" | "position"> & {
      projected_round: number | null;
      projected_overall_pick: number | null;
    }
  >();

  for (const [, group] of bySourceYear) {
    // Higher grade = better. Null grades get the worst rank in their source.
    const withGrade = group
      .filter((r) => r.consensus_grade !== null)
      .sort(
        (a, b) =>
          (b.consensus_grade as number) - (a.consensus_grade as number),
      );
    const withoutGrade = group.filter((r) => r.consensus_grade === null);
    withGrade.forEach((r, i) => {
      const arr = ranksByProspect.get(r.prospect_id) ?? [];
      arr.push(i + 1);
      ranksByProspect.set(r.prospect_id, arr);
      if (!meta.has(r.prospect_id)) {
        meta.set(r.prospect_id, {
          draft_year: r.draft_year,
          name: r.name,
          position: r.position,
          projected_round: r.projected_round,
          projected_overall_pick: r.projected_overall_pick,
        });
      }
    });
    const trailingRank = withGrade.length + 1;
    for (const r of withoutGrade) {
      const arr = ranksByProspect.get(r.prospect_id) ?? [];
      arr.push(trailingRank);
      ranksByProspect.set(r.prospect_id, arr);
      if (!meta.has(r.prospect_id)) {
        meta.set(r.prospect_id, {
          draft_year: r.draft_year,
          name: r.name,
          position: r.position,
          projected_round: r.projected_round,
          projected_overall_pick: r.projected_overall_pick,
        });
      }
    }
  }

  const consensus = Array.from(ranksByProspect.entries()).map(
    ([prospect_id, ranks]) => {
      const avgRank =
        ranks.reduce((a, b) => a + b, 0) / ranks.length;
      const m = meta.get(prospect_id)!;
      return {
        prospect_id,
        draft_year: m.draft_year,
        name: m.name,
        position: m.position,
        avg_rank: Number(avgRank.toFixed(2)),
        normalized_grade: rankToGrade(avgRank),
        source_count: ranks.length,
        projected_round: m.projected_round,
        projected_overall_pick: m.projected_overall_pick,
        updated_at: new Date().toISOString(),
      };
    },
  );

  consensus.sort(
    (a, b) =>
      a.draft_year - b.draft_year ||
      a.avg_rank - b.avg_rank,
  );

  console.log(`Consensus built from ${rows.length} rows → ${consensus.length} prospects`);
  const byYear = new Map<number, typeof consensus>();
  for (const c of consensus) {
    const arr = byYear.get(c.draft_year) ?? [];
    arr.push(c);
    byYear.set(c.draft_year, arr);
  }
  for (const [year, group] of [...byYear.entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    console.log(`\n${year} (${group.length} prospects):`);
    for (const c of group.slice(0, 10)) {
      console.log(
        `  #${c.avg_rank.toFixed(1).padStart(5)} ${c.name} (${c.position ?? "?"}) • grade ${c.normalized_grade} • ${c.source_count} src`,
      );
    }
    if (group.length > 10) {
      console.log(`  ... +${group.length - 10} more`);
    }
  }

  const BATCH = 500;
  for (let i = 0; i < consensus.length; i += BATCH) {
    const chunk = consensus.slice(i, i + BATCH);
    const { error: upErr } = await sb
      .from("prospect_consensus")
      .upsert(chunk, { onConflict: "prospect_id" });
    if (upErr) throw upErr;
  }
  console.log(`\nWrote ${consensus.length} prospect_consensus rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
