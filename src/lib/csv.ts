// Tiny CSV builder for the Pro-only export endpoints. Kept dependency-
// free on purpose — the volumes here are small (a 12-team league is a
// few hundred rows at most) and pulling in a parser library would be
// overkill.
//
// Excel-compatibility notes:
//   - CRLF line endings — Excel's CSV import on Windows handles LF, but
//     CRLF is the safer default for non-tech users opening files in
//     Numbers / Excel without changing settings.
//   - UTF-8 with no BOM. Player names are ASCII today; if we ever start
//     surfacing non-ASCII names we'll add a BOM here so Excel doesn't
//     mojibake them. Numbers/Sheets handle UTF-8 without one.
//   - Standard RFC 4180 quoting: wrap any cell containing comma, quote,
//     CR or LF in double-quotes and double the inner quotes.

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(headers: string[], rows: unknown[][]): string {
  const lines: string[] = [headers.map(csvEscape).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

// Wrap a CSV string in a Response with the right headers so the browser
// downloads it instead of rendering as plain text. Pass a filename
// without quotes — we add them. Cache-Control: no-store so a Pro user
// who downgrades doesn't see a stale 200 from an intermediate cache.
export function csvResponse(content: string, filename: string): Response {
  // Strip anything weird from the filename before interpolating into
  // the Content-Disposition header. Browsers tolerate a lot, but
  // double-quotes and newlines inside the header are a footgun.
  const safe = filename.replace(/["\r\n]/g, "_");
  return new Response(content, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safe}"`,
      "Cache-Control": "no-store",
    },
  });
}
