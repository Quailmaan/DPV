import Link from "next/link";
import { createServerClient } from "@/lib/supabase/server";
import { CURRENT_SEASON } from "@/lib/dpv/constants";
import type { ScoringFormat } from "@/lib/dpv/types";

// /rookies — current draft class view. Shows prospect consensus rankings
// pre-draft and overlays draft capital / team / combine / rookie prior DPV
// as each data source lands:
//
//   Pre-draft: prospect_consensus only → consensus grade visible, other
//     columns empty.
//   Post-draft (for a given pick): sync-draft-capital populates players row,
//     compute-dpv writes a rookie prior snapshot, ingest-combine attaches
//     RAS → all columns fill in automatically.
//
// Prospects and players are joined by normalized name (prospects predate
// gsis_id assignment). Unmatched rows on either side are still rendered.

const INCOMING_CLASS_YEAR = CURRENT_SEASON + 1;

type SearchParams = Promise<{ fmt?: string; pos?: string }>;

const FORMATS: { key: ScoringFormat; label: string }[] = [
  { key: "STANDARD", label: "Standard" },
  { key: "HALF_PPR", label: "Half PPR" },
  { key: "FULL_PPR", label: "Full PPR" },
];

const POSITIONS = ["ALL", "QB", "RB", "WR", "TE"] as const;

function isScoringFormat(v: string | undefined): v is ScoringFormat {
  return v === "STANDARD" || v === "HALF_PPR" || v === "FULL_PPR";
}

// Strip suffixes (Jr./III), punctuation, lowercase. Defensive against
// "Marvin Harrison Jr." vs "Marvin Harrison" etc.
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export default async function RookiesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const fmt: ScoringFormat = isScoringFormat(sp.fmt) ? sp.fmt : "HALF_PPR";
  const pos = (sp.pos || "ALL").toUpperCase();

  const sb = createServerClient();
  const [prospectsRes, playersRes, combineRes, snapsRes] = await Promise.all([
    sb
      .from("prospect_consensus")
      .select(
        "prospect_id, name, position, avg_rank, normalized_grade, source_count, projected_round, projected_overall_pick",
      )
      .eq("draft_year", INCOMING_CLASS_YEAR)
      .order("avg_rank", { ascending: true }),
    sb
      .from("players")
      .select("player_id, name, position, current_team, draft_round, draft_year")
      .eq("draft_year", INCOMING_CLASS_YEAR),
    sb
      .from("combine_stats")
      .select("player_id, athleticism_score, forty, vertical, broad_jump"),
    sb
      .from("dpv_snapshots")
      .select("player_id, dpv, tier, breakdown")
      .eq("scoring_format", fmt),
  ]);

  if (prospectsRes.error) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-4 text-red-900 dark:bg-red-950/40 dark:text-red-200">
        <p className="font-medium">Could not load rookies</p>
        <pre className="text-xs mt-2 opacity-80">
          {prospectsRes.error.message}
        </pre>
      </div>
    );
  }

  const prospects = prospectsRes.data ?? [];
  const players = playersRes.data ?? [];
  const combine = combineRes.data ?? [];
  const snaps = snapsRes.data ?? [];

  const playerByNorm = new Map<string, (typeof players)[number]>();
  for (const p of players) playerByNorm.set(normalize(p.name), p);

  const combineByPlayer = new Map<string, (typeof combine)[number]>();
  for (const c of combine) combineByPlayer.set(c.player_id, c);

  const snapByPlayer = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) snapByPlayer.set(s.player_id, s);

  type RookieRow = {
    key: string;
    name: string;
    position: string | null;
    consensusRank: number | null;
    consensusGrade: number | null;
    sourceCount: number | null;
    projectedRound: number | null;
    playerId: string | null;
    team: string | null;
    draftRound: number | null;
    ras: number | null;
    forty: number | null;
    dpv: number | null;
    tier: string | null;
  };

  const seenPlayerIds = new Set<string>();
  const rows: RookieRow[] = [];

  // 1. Prospect-first rows (pre-draft consensus has the most coverage).
  for (const pr of prospects) {
    const player = playerByNorm.get(normalize(pr.name));
    if (player) seenPlayerIds.add(player.player_id);
    const c = player ? combineByPlayer.get(player.player_id) : undefined;
    const s = player ? snapByPlayer.get(player.player_id) : undefined;
    rows.push({
      key: pr.prospect_id,
      name: pr.name,
      position: pr.position ?? player?.position ?? null,
      consensusRank: pr.avg_rank !== null ? Number(pr.avg_rank) : null,
      consensusGrade:
        pr.normalized_grade !== null ? Number(pr.normalized_grade) : null,
      sourceCount: pr.source_count ?? null,
      projectedRound: pr.projected_round ?? null,
      playerId: player?.player_id ?? null,
      team: player?.current_team ?? null,
      draftRound: player?.draft_round ?? null,
      ras:
        c?.athleticism_score !== null && c?.athleticism_score !== undefined
          ? Number(c.athleticism_score)
          : null,
      forty: c?.forty !== null && c?.forty !== undefined ? Number(c.forty) : null,
      dpv: s?.dpv ?? null,
      tier: s?.tier ?? null,
    });
  }

  // 2. Drafted rookies who aren't in prospects (late-round surprises).
  for (const player of players) {
    if (seenPlayerIds.has(player.player_id)) continue;
    const c = combineByPlayer.get(player.player_id);
    const s = snapByPlayer.get(player.player_id);
    rows.push({
      key: `player:${player.player_id}`,
      name: player.name,
      position: player.position,
      consensusRank: null,
      consensusGrade: null,
      sourceCount: null,
      projectedRound: null,
      playerId: player.player_id,
      team: player.current_team,
      draftRound: player.draft_round,
      ras:
        c?.athleticism_score !== null && c?.athleticism_score !== undefined
          ? Number(c.athleticism_score)
          : null,
      forty: c?.forty !== null && c?.forty !== undefined ? Number(c.forty) : null,
      dpv: s?.dpv ?? null,
      tier: s?.tier ?? null,
    });
  }

  // Filter + sort. Drafted rookies float above undrafted via the sort key.
  const filtered = rows.filter((r) =>
    pos === "ALL" ? true : r.position === pos,
  );

  filtered.sort((a, b) => {
    // 1. Drafted with DPV first, sorted by DPV desc.
    if (a.dpv !== null && b.dpv !== null) return b.dpv - a.dpv;
    if (a.dpv !== null) return -1;
    if (b.dpv !== null) return 1;
    // 2. Drafted without DPV yet — use draft round (earlier = higher).
    if (a.draftRound !== null && b.draftRound !== null)
      return a.draftRound - b.draftRound;
    if (a.draftRound !== null) return -1;
    if (b.draftRound !== null) return 1;
    // 3. Undrafted — consensus rank ascending (lower = better).
    if (a.consensusRank !== null && b.consensusRank !== null)
      return a.consensusRank - b.consensusRank;
    if (a.consensusRank !== null) return -1;
    if (b.consensusRank !== null) return 1;
    return a.name.localeCompare(b.name);
  });

  const buildHref = (updates: Partial<{ fmt: string; pos: string }>) => {
    const params = new URLSearchParams();
    const next = { fmt, pos, ...updates };
    if (next.fmt !== "HALF_PPR") params.set("fmt", next.fmt);
    if (next.pos && next.pos !== "ALL") params.set("pos", next.pos);
    const s = params.toString();
    return s ? `/rookies?${s}` : "/rookies";
  };

  const draftedCount = rows.filter((r) => r.draftRound !== null).length;
  const totalCount = rows.length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {INCOMING_CLASS_YEAR} Rookie Class
        </h1>
        <p className="text-sm text-zinc-500 mt-1">
          Pre-draft consensus grades + post-draft rookie prior DPV (draft
          capital, landing spot, combine, and intra-class depth). Updates as
          picks come in.
        </p>
        <p className="text-xs text-zinc-400 mt-1 tabular-nums">
          {draftedCount}/{totalCount} drafted · {rows.filter((r) => r.dpv !== null).length} with DPV prior
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {FORMATS.map((f) => (
            <Link
              key={f.key}
              href={buildHref({ fmt: f.key })}
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
        <div className="flex rounded-md border border-zinc-200 dark:border-zinc-800 overflow-hidden text-sm">
          {POSITIONS.map((p) => (
            <Link
              key={p}
              href={buildHref({ pos: p })}
              className={`px-3 py-1.5 ${
                pos === p
                  ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                  : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
              }`}
            >
              {p}
            </Link>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-sm text-zinc-500">
          No rookies in this class yet. Prospect sync pulls consensus rankings;
          post-draft <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs">sync-draft-capital.ts</code>{" "}
          attaches pick data.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500 bg-zinc-50 dark:bg-zinc-950">
              <tr>
                <th className="px-3 py-2 text-left w-10">#</th>
                <th className="px-3 py-2 text-left">Player</th>
                <th className="px-3 py-2 text-left w-14">Pos</th>
                <th className="px-3 py-2 text-left w-20">Team</th>
                <th className="px-3 py-2 text-center w-14">Rd</th>
                <th className="px-3 py-2 text-right w-16">Grade</th>
                <th className="px-3 py-2 text-right w-14">RAS</th>
                <th className="px-3 py-2 text-right w-14">40</th>
                <th className="px-3 py-2 text-right w-20">DPV</th>
                <th className="px-3 py-2 text-left w-36">Tier</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={r.key}
                  className="border-t border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <td className="px-3 py-2 text-zinc-400 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    {r.playerId ? (
                      <Link
                        href={`/player/${r.playerId}?fmt=${fmt}`}
                        className="hover:underline"
                      >
                        {r.name}
                      </Link>
                    ) : (
                      r.name
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {r.position ? (
                      <span className="inline-block rounded bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 text-xs font-mono">
                        {r.position}
                      </span>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-zinc-500">{r.team ?? "—"}</td>
                  <td className="px-3 py-2 text-center text-zinc-500 tabular-nums">
                    {r.draftRound ? `R${r.draftRound}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.consensusGrade !== null
                      ? r.consensusGrade.toFixed(0)
                      : "—"}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      r.ras === null
                        ? "text-zinc-400"
                        : r.ras >= 8
                        ? "text-emerald-600 dark:text-emerald-400 font-medium"
                        : r.ras >= 5
                        ? "text-zinc-600 dark:text-zinc-300"
                        : "text-rose-600 dark:text-rose-400"
                    }`}
                  >
                    {r.ras !== null ? r.ras.toFixed(1) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                    {r.forty !== null ? r.forty.toFixed(2) : "—"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold">
                    {r.dpv !== null ? r.dpv : <span className="text-zinc-400 font-normal">—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-zinc-500">
                    {r.tier ?? (
                      <span className="text-zinc-400">Pre-draft</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
