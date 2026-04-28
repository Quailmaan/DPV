// Pro-only CSV export — top 200 unrostered ranked players. Same cap
// the page uses, sorted by PYV descending. No position filter (the
// downloader can sort/filter in their spreadsheet).

import {
  buildFreeAgentsCsv,
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

  const csv = buildFreeAgentsCsv(ctx);
  const filename = `pylon-${leagueSlug(ctx.league.name, id)}-free-agents.csv`;
  return csvResponse(csv, filename);
}
