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
// Projected NFL pick / round is averaged separately across sources that
// provided one. This feeds compute-class-strength.ts, which counts how many
// offensive prospects per year project inside Round 1 / top 15 — the
// cross-year anchor the slot-aware pick curve runs on.
//
// A prospect only ranked by one source is still included, with source_count
// = 1 so downstream consumers can weight or filter by agreement.

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

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
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

  const bySourceYear = new Map<string, Row[]>();
  for (const r of rows) {
    const k = `${r.source}|${r.draft_year}`;
    const arr = bySourceYear.get(k) ?? [];
    arr.push(r);
    bySourceYear.set(k, arr);
  }

  const ranksByProspect = new Map<string, number[]>();
  const projPicksByProspect = new Map<string, number[]>();
  const projRoundsByProspect = new Map<string, number[]>();
  const meta = new Map<
    string,
    Pick<Row, "draft_year" | "name" | "position">
  >();

  const remember = (r: Row) => {
    if (!meta.has(r.prospect_id)) {
      meta.set(r.prospect_id, {
        draft_year: r.draft_year,
        name: r.name,
        position: r.position,
      });
    }
    if (r.projected_overall_pick !== null) {
      const arr = projPicksByProspect.get(r.prospect_id) ?? [];
      arr.push(Number(r.projected_overall_pick));
      projPicksByProspect.set(r.prospect_id, arr);
    }
    if (r.projected_round !== null) {
      const arr = projRoundsByProspect.get(r.prospect_id) ?? [];
      arr.push(Number(r.projected_round));
      projRoundsByProspect.set(r.prospect_id, arr);
    }
  };

  for (const [, group] of bySourceYear) {
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
      remember(r);
    });
    const trailingRank = withGrade.length + 1;
    for (const r of withoutGrade) {
      const arr = ranksByProspect.get(r.prospect_id) ?? [];
      arr.push(trailingRank);
      ranksByProspect.set(r.prospect_id, arr);
      remember(r);
    }
  }

  const consensus = Array.from(ranksByProspect.entries()).map(
    ([prospect_id, ranks]) => {
      const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
      const m = meta.get(prospect_id)!;
      const avgPick = mean(projPicksByProspect.get(prospect_id) ?? []);
      const avgRound = mean(projRoundsByProspect.get(prospect_id) ?? []);
      return {
        prospect_id,
        draft_year: m.draft_year,
        name: m.name,
        position: m.position,
        avg_rank: Number(avgRank.toFixed(2)),
        normalized_grade: rankToGrade(avgRank),
        source_count: ranks.length,
        projected_round: avgRound !== null ? Math.round(avgRound) : null,
        projected_overall_pick: avgPick !== null ? Math.round(avgPick) : null,
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
      const pick = c.projected_overall_pick ?? "—";
      console.log(
        `  #${c.avg_rank.toFixed(1).padStart(5)} ${c.name} (${c.position ?? "?"}) • grade ${c.normalized_grade} • pick ${pick} • ${c.source_count} src`,
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
