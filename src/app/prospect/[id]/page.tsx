import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";

// /prospect/[id] — pre-draft prospect detail. Shows what we know before
// the player has a gsis_id: cross-source consensus grade, per-source ranks,
// projected round/pick. Once the prospect gets drafted and lands in the
// `players` table, /rookies links them to /player/[id] instead (fuller
// profile with combine, rookie prior DPV, and seasons).

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function gradeColorClass(grade: number | null): string {
  if (grade === null) return "text-zinc-400";
  if (grade >= 85) return "text-emerald-600 dark:text-emerald-400";
  if (grade >= 70) return "text-sky-600 dark:text-sky-400";
  if (grade >= 50) return "text-zinc-700 dark:text-zinc-200";
  return "text-zinc-500";
}

function roundLabel(r: number | null): string {
  if (r === null) return "—";
  if (r <= 3) return `Round ${r}`;
  if (r <= 7) return `Round ${r}`;
  return "Undrafted FA";
}

export default async function ProspectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const sb = createServerClient();

  const [consensusRes, sourcesRes] = await Promise.all([
    sb
      .from("prospect_consensus")
      .select("*")
      .eq("prospect_id", id)
      .maybeSingle(),
    sb
      .from("prospects")
      .select(
        "source, consensus_grade, projected_round, projected_overall_pick, updated_at",
      )
      .eq("prospect_id", id),
  ]);

  if (consensusRes.error || !consensusRes.data) return notFound();
  const prospect = consensusRes.data;
  const sources = sourcesRes.data ?? [];

  // If the prospect has since been drafted (or has a name match in players
  // for the same draft class), let the visitor jump to the full profile.
  const { data: playerMatches } = await sb
    .from("players")
    .select("player_id, name, position, current_team, draft_round, draft_year")
    .eq("draft_year", prospect.draft_year);
  const linkedPlayer =
    (playerMatches ?? []).find(
      (p) => normalize(p.name) === normalize(prospect.name),
    ) ?? null;

  // Class-strength context — same class aggregate used on the trade calc.
  const { data: classRow } = await sb
    .from("class_strength")
    .select("*")
    .eq("draft_year", prospect.draft_year)
    .maybeSingle();

  const grade =
    prospect.normalized_grade !== null
      ? Number(prospect.normalized_grade)
      : null;
  const avgRank =
    prospect.avg_rank !== null ? Number(prospect.avg_rank) : null;

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/rookies"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Rookie class
        </Link>
      </div>

      <div className="flex items-start justify-between gap-6 mb-8 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {prospect.name}
          </h1>
          <div className="text-sm text-zinc-500 mt-1 flex gap-3 flex-wrap">
            <span>{prospect.position ?? "—"}</span>
            <span>·</span>
            <span>{prospect.draft_year} class</span>
            <span>·</span>
            <span>Pre-draft prospect</span>
          </div>
        </div>
        {linkedPlayer && (
          <Link
            href={`/player/${linkedPlayer.player_id}`}
            className="inline-flex items-center rounded-md border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 px-3 py-1.5 text-sm hover:bg-emerald-100 dark:hover:bg-emerald-900/40"
          >
            View full player profile →
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Consensus Grade
          </div>
          <div
            className={`text-4xl font-bold tabular-nums mt-1 ${gradeColorClass(
              grade,
            )}`}
          >
            {grade !== null ? grade.toFixed(0) : "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            {prospect.source_count} source
            {prospect.source_count === 1 ? "" : "s"}, normalized 0–100
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Avg Rank
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {avgRank !== null ? avgRank.toFixed(1) : "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            Mean across sources (1 = best)
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Projected Round
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {prospect.projected_round ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            {roundLabel(prospect.projected_round)}
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Projected Pick
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {prospect.projected_overall_pick
              ? `#${prospect.projected_overall_pick}`
              : "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            Overall across all teams
          </div>
        </div>
      </div>

      {sources.length > 0 && (
        <div className="mb-8">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-lg font-semibold">Per-source grades</h2>
            <div className="text-xs text-zinc-500">
              Raw grades before cross-source normalization
            </div>
          </div>
          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-right">Grade</th>
                  <th className="px-3 py-2 text-right">Proj Round</th>
                  <th className="px-3 py-2 text-right">Proj Pick</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr
                    key={s.source}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-3 py-2 font-mono text-xs">{s.source}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.consensus_grade !== null
                        ? Number(s.consensus_grade).toFixed(1)
                        : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {s.projected_round ?? "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {s.projected_overall_pick
                        ? `#${s.projected_overall_pick}`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {classRow && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Class Context</h2>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {(
                  [
                    [
                      "R1 Offensive Prospects",
                      classRow.r1_offensive_count ?? "—",
                    ],
                    [
                      "Top-15 Offensive Prospects",
                      classRow.top15_offensive_count ?? "—",
                    ],
                    [
                      "Top-10 Average Grade",
                      classRow.top10_avg_grade !== null &&
                      classRow.top10_avg_grade !== undefined
                        ? Number(classRow.top10_avg_grade).toFixed(1)
                        : "—",
                    ],
                    [
                      "Class Multiplier",
                      classRow.multiplier !== null &&
                      classRow.multiplier !== undefined
                        ? `×${Number(classRow.multiplier).toFixed(2)}`
                        : "—",
                    ],
                  ] as Array<[string, string | number]>
                ).map(([label, value]) => (
                  <tr
                    key={label}
                    className="border-t border-zinc-100 dark:border-zinc-800 first:border-t-0"
                  >
                    <td className="px-4 py-2 text-zinc-500">{label}</td>
                    <td className="px-4 py-2 text-right font-medium tabular-nums">
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-zinc-500 mt-2">
            Aggregate strength of the {prospect.draft_year} class. Feeds the
            pick-value calculator on the trade page.
          </p>
        </div>
      )}

      {!linkedPlayer && (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/40 p-4 text-sm text-zinc-600 dark:text-zinc-400">
          <b className="text-zinc-800 dark:text-zinc-200">No NFL team yet.</b>{" "}
          Rookie prior DPV, combine athleticism, and landing-spot modifiers
          unlock once this prospect is drafted. The full player profile will
          appear here automatically after the nightly refresh picks up their
          roster entry.
        </div>
      )}
    </div>
  );
}
