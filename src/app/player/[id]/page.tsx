import Link from "next/link";
import { notFound } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import type { DPVBreakdown } from "@/lib/dpv/types";
import type { ScoringFormat } from "@/lib/dpv/types";

const FORMATS: { key: ScoringFormat; label: string }[] = [
  { key: "STANDARD", label: "Standard" },
  { key: "HALF_PPR", label: "Half PPR" },
  { key: "FULL_PPR", label: "Full PPR" },
];

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

function ageFromBirth(bd: string | null): number | null {
  if (!bd) return null;
  return (
    (Date.now() - new Date(bd).getTime()) /
    (365.25 * 24 * 3600 * 1000)
  );
}

export default async function PlayerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ fmt?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";

  const sb = createServerClient();

  const [playerRes, seasonsRes, snapshotRes] = await Promise.all([
    sb.from("players").select("*").eq("player_id", id).maybeSingle(),
    sb
      .from("player_seasons")
      .select("*")
      .eq("player_id", id)
      .order("season", { ascending: false }),
    sb
      .from("dpv_snapshots")
      .select("*")
      .eq("player_id", id)
      .eq("scoring_format", fmt)
      .maybeSingle(),
  ]);

  if (playerRes.error || !playerRes.data) return notFound();

  const player = playerRes.data;
  const seasons = seasonsRes.data ?? [];
  const snapshot = snapshotRes.data;
  const breakdown = snapshot?.breakdown as DPVBreakdown | undefined;
  const age = ageFromBirth(player.birthdate);

  return (
    <div>
      <div className="mb-6">
        <Link
          href="/"
          className="text-sm text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100"
        >
          ← Rankings
        </Link>
      </div>

      <div className="flex items-start justify-between gap-6 mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {player.name}
          </h1>
          <div className="text-sm text-zinc-500 mt-1 flex gap-3">
            <span>{player.position}</span>
            <span>·</span>
            <span>{player.current_team ?? "—"}</span>
            <span>·</span>
            <span>Age {age !== null ? age.toFixed(1) : "—"}</span>
          </div>
        </div>
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {FORMATS.map((f) => (
            <Link
              key={f.key}
              href={`/player/${id}?fmt=${f.key}`}
              className={`px-3 py-1.5 ${
                fmt === f.key
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            DPV
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {snapshot?.dpv ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            {snapshot?.tier ?? "No snapshot"}
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            BPS (3-yr weighted PPG)
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            {breakdown?.bps.toFixed(1) ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            Recency-weighted fantasy PPG
          </div>
        </div>
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5">
          <div className="text-xs uppercase tracking-wider text-zinc-500">
            Age Modifier
          </div>
          <div className="text-4xl font-bold tabular-nums mt-1">
            ×{breakdown?.ageModifier.toFixed(2) ?? "—"}
          </div>
          <div className="text-sm text-zinc-500 mt-1">
            Position-specific aging curve
          </div>
        </div>
      </div>

      {breakdown && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Breakdown</h2>
          <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                {[
                  ["Base Production Score", breakdown.bps.toFixed(2)],
                  ["Age Modifier", `×${breakdown.ageModifier.toFixed(3)}`],
                  ["Opportunity Score", breakdown.opportunityScore.toFixed(3)],
                  ["O-Line Modifier", `×${breakdown.olineModifier.toFixed(3)}`],
                  ["QB Quality Modifier", `×${breakdown.qbQualityModifier.toFixed(3)}`],
                  ["Boom/Bust Modifier", `×${breakdown.bbcsModifier.toFixed(3)}`],
                  ["Scoring Format Weight", `×${breakdown.scoringFormatWeight.toFixed(3)}`],
                  ["Positional Scarcity", `×${breakdown.scarcityMultiplier.toFixed(3)}`],
                  ["Raw DPV", breakdown.dpvRaw.toFixed(2)],
                  ["HSM Confidence", breakdown.hsmConfidence],
                ].map(([label, value]) => (
                  <tr
                    key={label}
                    className="border-t border-zinc-100 dark:border-zinc-800 first:border-t-0"
                  >
                    <td className="px-4 py-2 text-zinc-500">{label}</td>
                    <td className="px-4 py-2 text-right tabular-nums font-medium">
                      {value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-3">Seasons</h2>
        {seasons.length === 0 ? (
          <div className="text-sm text-zinc-500">No season data.</div>
        ) : (
          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
                <tr>
                  <th className="px-3 py-2 text-left">Season</th>
                  <th className="px-3 py-2 text-left">Team</th>
                  <th className="px-3 py-2 text-right">G</th>
                  <th className="px-3 py-2 text-right">Pass Yd</th>
                  <th className="px-3 py-2 text-right">Pass TD</th>
                  <th className="px-3 py-2 text-right">Rush Yd</th>
                  <th className="px-3 py-2 text-right">Rush TD</th>
                  <th className="px-3 py-2 text-right">Rec</th>
                  <th className="px-3 py-2 text-right">Rec Yd</th>
                  <th className="px-3 py-2 text-right">Rec TD</th>
                  <th className="px-3 py-2 text-right">Snap%</th>
                  <th className="px-3 py-2 text-right">Tgt%</th>
                </tr>
              </thead>
              <tbody>
                {seasons.map((s) => (
                  <tr
                    key={s.season}
                    className="border-t border-zinc-100 dark:border-zinc-800"
                  >
                    <td className="px-3 py-2 font-medium">{s.season}</td>
                    <td className="px-3 py-2 text-zinc-500">{s.team ?? "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.games_played}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.passing_yards || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.passing_tds || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.rushing_yards || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.rushing_tds || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.receptions || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.receiving_yards || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{s.receiving_tds || "—"}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.snap_share_pct ? s.snap_share_pct.toFixed(0) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {s.target_share_pct ? s.target_share_pct.toFixed(1) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
