// Pro-only CSV export — one team's roster. Sorted by PYV descending,
// includes sell-window labels and reasons so the downloader has the
// "should I shop this guy?" context the on-screen badge gives.

import {
  buildTeamRosterCsv,
  leagueSlug,
  loadExportContext,
} from "@/lib/league/exportData";
import { csvResponse } from "@/lib/csv";
import { guardExport } from "../../guard";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; rosterId: string }> },
) {
  const { id, rosterId: rosterIdRaw } = await params;
  const rosterId = Number.parseInt(rosterIdRaw, 10);
  if (!Number.isFinite(rosterId)) {
    return Response.json({ error: "Invalid roster id." }, { status: 400 });
  }

  const guard = await guardExport(id);
  if (!guard.ok) return guard.response;

  const ctx = await loadExportContext(guard.sb, id);
  if (!ctx) {
    return Response.json({ error: "League not found." }, { status: 404 });
  }

  const csv = buildTeamRosterCsv(ctx, rosterId);
  if (csv === null) {
    return Response.json(
      { error: "Roster not found in this league." },
      { status: 404 },
    );
  }

  // Owner name in the filename so the user can tell roster CSVs apart
  // when they download a few. Slug it so we don't end up with spaces or
  // punctuation in the Content-Disposition header.
  const summary = ctx.summaries.find((s) => s.rosterId === rosterId);
  const ownerSlug = summary
    ? leagueSlug(summary.ownerName, `team-${rosterId}`)
    : `team-${rosterId}`;
  const filename = `pylon-${leagueSlug(ctx.league.name, id)}-${ownerSlug}-roster.csv`;
  return csvResponse(csv, filename);
}
