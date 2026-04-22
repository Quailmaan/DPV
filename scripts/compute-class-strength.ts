import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
dotenvConfig();
import { createClient } from "@supabase/supabase-js";

// Aggregate prospect_consensus by draft_year into per-year class strength
// multipliers. Reads the cross-source consensus grade (built by
// compute-prospect-consensus.ts) so scales across sources are already
// normalized before we aggregate.
//
// Approach:
//   - Take the top 10 normalized grades per year (sorted desc).
//   - Compute the top-10 average grade per year.
//   - Compute the cross-year mean of top-10 averages (the "neutral" class).
//   - multiplier = clamp(1 + k * (year_avg - cross_year_mean) / scale, 0.9, 1.1)
//
// Years with fewer than 5 graded prospects get multiplier = 1.0 (not enough
// signal to move off neutral).
//
// If only ONE year has grades in the table, all years fall back to 1.0 —
// there's no cross-year basis to compare against.

const MIN_PROSPECTS_FOR_SIGNAL = 5;
const SENSITIVITY = 0.6;
const MULT_FLOOR = 0.9;
const MULT_CEIL = 1.1;

async function main() {
  const sb = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    { auth: { persistSession: false } },
  );

  const { data, error } = await sb
    .from("prospect_consensus")
    .select("draft_year, normalized_grade")
    .not("normalized_grade", "is", null);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    draft_year: number;
    normalized_grade: number;
  }>;

  const byYear = new Map<number, number[]>();
  for (const r of rows) {
    const arr = byYear.get(r.draft_year) ?? [];
    arr.push(Number(r.normalized_grade));
    byYear.set(r.draft_year, arr);
  }

  const years = Array.from(byYear.keys()).sort();
  if (years.length === 0) {
    console.log("No graded prospects found. Nothing to compute.");
    return;
  }

  type Summary = {
    draft_year: number;
    top10_avg_grade: number | null;
    top30_avg_grade: number | null;
    prospect_count: number;
  };
  const summaries: Summary[] = years.map((year) => {
    const grades = (byYear.get(year) ?? []).sort((a, b) => b - a);
    const top10 = grades.slice(0, 10);
    const top30 = grades.slice(0, 30);
    const avg = (xs: number[]) =>
      xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      draft_year: year,
      top10_avg_grade: top10.length >= 3 ? avg(top10) : null,
      top30_avg_grade: top30.length >= 5 ? avg(top30) : null,
      prospect_count: grades.length,
    };
  });

  const usableTop10 = summaries
    .filter((s) => s.top10_avg_grade !== null && s.prospect_count >= MIN_PROSPECTS_FOR_SIGNAL)
    .map((s) => s.top10_avg_grade as number);
  const crossMean =
    usableTop10.length > 0
      ? usableTop10.reduce((a, b) => a + b, 0) / usableTop10.length
      : null;
  // Use absolute-deviation average as a rough spread scale.
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
      top10_avg_grade:
        s.top10_avg_grade !== null ? Number(s.top10_avg_grade.toFixed(2)) : null,
      top30_avg_grade:
        s.top30_avg_grade !== null ? Number(s.top30_avg_grade.toFixed(2)) : null,
      prospect_count: s.prospect_count,
      updated_at: new Date().toISOString(),
    };
  });

  console.log("Class strength:");
  for (const p of payload) {
    console.log(
      `  ${p.draft_year}: ×${p.multiplier}  (top10 avg ${p.top10_avg_grade ?? "—"}, n=${p.prospect_count})`,
    );
  }

  const { error: upErr } = await sb
    .from("class_strength")
    .upsert(payload, { onConflict: "draft_year" });
  if (upErr) throw upErr;
  console.log(`Wrote ${payload.length} rows.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
