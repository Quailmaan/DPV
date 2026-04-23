import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

// Aggregate prospect_consensus into per-year class depth counts. The
// slot-aware pick curve (src/lib/picks/constants.ts) runs on these counts:
//
//   r1_offensive_count  = offensive prospects (QB/RB/WR/TE) whose averaged
//                         projected_overall_pick is ≤ 32
//   top15_offensive_count = same, but ≤ 15
//
// Unlike the previous top-10 grade-average approach, these counts are
// genuinely cross-year comparable — an NFL Round 1 pick means the same
// thing in 2026 and 2027. That lets us say "2027 is deeper than 2026"
// with actual data instead of within-year rankings, which are zero-sum.
//
// We also keep the legacy top10_avg_grade / multiplier fields populated
// for readers/dashboards that haven't migrated, but they no longer drive
// pick DPV directly.

const MIN_PROSPECTS_FOR_SIGNAL = 5;
const SENSITIVITY = 0.6;
const MULT_FLOOR = 0.9;
const MULT_CEIL = 1.1;

const OFFENSE = new Set(["QB", "RB", "WR", "TE"]);

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await sb
    .from("prospect_consensus")
    .select(
      "draft_year, position, normalized_grade, projected_overall_pick",
    );
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    draft_year: number;
    position: string | null;
    normalized_grade: number | null;
    projected_overall_pick: number | null;
  }>;

  if (rows.length === 0) {
    console.log("No graded prospects found. Nothing to compute.");
    return;
  }

  type Bucket = {
    grades: number[];
    r1OffenseCount: number;
    top15OffenseCount: number;
    prospectCount: number;
  };
  const byYear = new Map<number, Bucket>();
  const getBucket = (year: number): Bucket => {
    let b = byYear.get(year);
    if (!b) {
      b = { grades: [], r1OffenseCount: 0, top15OffenseCount: 0, prospectCount: 0 };
      byYear.set(year, b);
    }
    return b;
  };

  for (const r of rows) {
    const b = getBucket(r.draft_year);
    b.prospectCount++;
    if (r.normalized_grade !== null) b.grades.push(Number(r.normalized_grade));
    const pos = (r.position ?? "").toUpperCase();
    const pick = r.projected_overall_pick;
    if (OFFENSE.has(pos) && pick !== null) {
      if (pick <= 32) b.r1OffenseCount++;
      if (pick <= 15) b.top15OffenseCount++;
    }
  }

  const years = [...byYear.keys()].sort();

  // Legacy multiplier — kept for back-compat. Uses top-10 grade average vs
  // cross-year mean, clamped to [0.9, 1.1]. Not consumed by the pick curve.
  type Summary = {
    draft_year: number;
    top10_avg_grade: number | null;
    top30_avg_grade: number | null;
    prospect_count: number;
    r1_offensive_count: number;
    top15_offensive_count: number;
  };
  const summaries: Summary[] = years.map((year) => {
    const b = byYear.get(year)!;
    const sorted = [...b.grades].sort((a, b) => b - a);
    const avg = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      draft_year: year,
      top10_avg_grade: sorted.length >= 3 ? avg(sorted.slice(0, 10)) : null,
      top30_avg_grade: sorted.length >= 5 ? avg(sorted.slice(0, 30)) : null,
      prospect_count: b.prospectCount,
      r1_offensive_count: b.r1OffenseCount,
      top15_offensive_count: b.top15OffenseCount,
    };
  });

  const usableTop10 = summaries
    .filter(
      (s) =>
        s.top10_avg_grade !== null &&
        s.prospect_count >= MIN_PROSPECTS_FOR_SIGNAL,
    )
    .map((s) => s.top10_avg_grade as number);
  const crossMean =
    usableTop10.length > 0
      ? usableTop10.reduce((a, b) => a + b, 0) / usableTop10.length
      : null;
  const scale =
    usableTop10.length > 1 && crossMean !== null
      ? Math.max(
          0.5,
          usableTop10.reduce((a, b) => a + Math.abs(b - crossMean), 0) /
            usableTop10.length,
        )
      : null;

  const payload = summaries.map((s) => {
    let multiplier = 1.0;
    if (
      crossMean !== null &&
      scale !== null &&
      s.top10_avg_grade !== null &&
      s.prospect_count >= MIN_PROSPECTS_FOR_SIGNAL
    ) {
      const deviation = (s.top10_avg_grade - crossMean) / scale;
      multiplier = Math.max(
        MULT_FLOOR,
        Math.min(MULT_CEIL, 1 + SENSITIVITY * deviation * 0.05),
      );
    }
    return {
      draft_year: s.draft_year,
      multiplier: Number(multiplier.toFixed(3)),
      r1_offensive_count: s.r1_offensive_count,
      top15_offensive_count: s.top15_offensive_count,
      top10_avg_grade:
        s.top10_avg_grade !== null ? Number(s.top10_avg_grade.toFixed(2)) : null,
      top30_avg_grade:
        s.top30_avg_grade !== null ? Number(s.top30_avg_grade.toFixed(2)) : null,
      prospect_count: s.prospect_count,
      updated_at: new Date().toISOString(),
    };
  });

  console.log("Class depth (drives pick curve via slot-aware multiplier):");
  for (const p of payload) {
    console.log(
      `  ${p.draft_year}: R1 offense=${p.r1_offensive_count}, top15 offense=${p.top15_offensive_count}  (legacy ×${p.multiplier}, n=${p.prospect_count})`,
    );
  }

  const { error: upErr } = await sb
    .from("class_strength")
    .upsert(payload, { onConflict: "draft_year" });
  if (upErr) throw upErr;
  console.log(`\nWrote ${payload.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
