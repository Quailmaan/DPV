// Pro-only CSV export — league power rankings. One row per team with
// total PYV, per-position breakdown, and the top player. Mirrors the
// rankings table on /league/[id].

import {
  buildRankingsCsv,
  leagueSlug,
  loadExportContext,
} from "@/lib/league/exportData";
import { csvResponse } from "@/lib/csv";
import { guardExport } from "../guard";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const guard = await guardExport(id);
  if (!guard.ok) return guard.response;

  const ctx = await loadExportContext(guard.sb, id);
  if (!ctx) {
    return Response.json({ error: "League not found." }, { status: 404 });
  }

  const csv = buildRankingsCsv(ctx);
  const filename = `pylon-${leagueSlug(ctx.league.name, id)}-rankings.csv`;
  return csvResponse(csv, filename);
}
