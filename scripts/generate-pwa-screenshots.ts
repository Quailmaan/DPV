/**
 * Generate PWA install-dialog screenshots for the manifest.
 *
 * Chrome's "Richer PWA Install UI" panel (the dialog with app preview
 * cards instead of just an icon) requires the manifest to declare at
 * least one screenshot per form factor:
 *   - form_factor: "wide"   → desktop dialog (1280×720 here)
 *   - form_factor: "narrow" → mobile dialog (1080×1920 here)
 *
 * We synthesize the screenshots from SVG via sharp rather than driving
 * a real headless browser. Two reasons:
 *   1. We can curate the showcased players + the rankings layout to
 *      look polished, instead of whatever the prod DB happens to have
 *      ranked at the moment we'd capture (e.g. RB19 in second place
 *      because of a roster bug — would actively undersell the product).
 *   2. Avoids a ~200 MB Playwright/Puppeteer dev dependency for a
 *      task we'd run a handful of times a year.
 *
 * Run: `npx tsx scripts/generate-pwa-screenshots.ts`
 * Output: public/screenshots/wide.png, public/screenshots/narrow.png
 */
import sharp from "sharp";
import path from "node:path";
import { mkdirSync } from "node:fs";

const OUT = path.join(process.cwd(), "public/screenshots");
mkdirSync(OUT, { recursive: true });

// Brand palette mirrors the live site. Keeping it in one place so the
// two SVGs stay visually consistent and any rebrand only edits here.
const C = {
  bg: "#09090b", // zinc-950 — page background
  card: "#18181b", // zinc-900 — surfaces
  border: "#27272a", // zinc-800 — borders
  text: "#ffffff",
  muted: "#a1a1aa", // zinc-400
  faint: "#71717a", // zinc-500
  accent: "#ea580c", // orange-600 — the Y in PYLON
  emerald: "#10b981", // emerald-500 — PYV value
  cta: "#059669", // emerald-600 — primary button
};

// Curated showcase rows. Real names so it feels authentic, but order
// is hand-chosen to read naturally rather than reflecting any specific
// scoring snapshot.
const ROWS = [
  { name: "Patrick Mahomes", pos: "QB", team: "KC", pyv: "9,821" },
  { name: "Justin Jefferson", pos: "WR", team: "MIN", pyv: "9,503" },
  { name: "CeeDee Lamb", pos: "WR", team: "DAL", pyv: "9,287" },
  { name: "Bijan Robinson", pos: "RB", team: "ATL", pyv: "9,142" },
  { name: "Ja'Marr Chase", pos: "WR", team: "CIN", pyv: "8,971" },
  { name: "Christian McCaffrey", pos: "RB", team: "SF", pyv: "8,825" },
  { name: "Lamar Jackson", pos: "QB", team: "BAL", pyv: "8,704" },
  { name: "Josh Allen", pos: "QB", team: "BUF", pyv: "8,612" },
];

// Web-safe font stack. librsvg/Pango will resolve these via the system
// font config. Arial is the universal fallback that exists on every
// Windows / macOS / Linux machine.
const FONT = "Arial, Helvetica, sans-serif";

function pylonWordmark(x: number, y: number, fontSize: number): string {
  // Manual letter spacing because tspan doesn't compose easily with
  // text-anchor; we want the orange Y inline with white P, L, O, N.
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${fontSize}" font-weight="800" fill="${C.text}" letter-spacing="${fontSize * 0.02}">P<tspan fill="${C.accent}">Y</tspan>LON</text>`;
}

function buildWideSvg(): string {
  const w = 1280;
  const h = 720;
  const headerH = 56;
  const padX = 64;

  // Right-side rankings card position
  const cardX = 720;
  const cardY = 96;
  const cardW = 496;
  const cardH = 552;
  const rowStartY = cardY + 86;
  const rowH = 54;
  const colName = cardX + 24 + 40; // # column = 40 wide
  const colPyv = cardX + cardW - 24;

  const rowsSvg = ROWS.slice(0, 8)
    .map((r, i) => {
      const y = rowStartY + i * rowH;
      return `
    <text x="${cardX + 24}" y="${y + 22}" font-family="${FONT}" font-size="14" fill="${C.faint}" font-weight="500">${i + 1}</text>
    <text x="${colName}" y="${y + 16}" font-family="${FONT}" font-size="14" fill="${C.text}" font-weight="600">${escapeXml(r.name)}</text>
    <text x="${colName}" y="${y + 34}" font-family="${FONT}" font-size="11" fill="${C.faint}">${r.pos} · ${r.team}</text>
    <text x="${colPyv}" y="${y + 22}" font-family="${FONT}" font-size="15" fill="${C.emerald}" font-weight="600" text-anchor="end">${r.pyv}</text>
    ${i < 7 ? `<line x1="${cardX + 24}" y1="${y + 46}" x2="${cardX + cardW - 24}" y2="${y + 46}" stroke="${C.border}" stroke-width="1"/>` : ""}`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${C.bg}"/>

  <!-- Header bar -->
  <rect width="${w}" height="${headerH}" fill="${C.card}"/>
  <line x1="0" y1="${headerH}" x2="${w}" y2="${headerH}" stroke="${C.border}" stroke-width="1"/>
  ${pylonWordmark(padX - 32, 36, 22)}

  <!-- Mock nav links -->
  <text x="${padX + 88}" y="36" font-family="${FONT}" font-size="13" fill="${C.muted}">Rankings</text>
  <text x="${padX + 168}" y="36" font-family="${FONT}" font-size="13" fill="${C.muted}">Rookies</text>
  <text x="${padX + 246}" y="36" font-family="${FONT}" font-size="13" fill="${C.muted}">Leagues</text>
  <text x="${padX + 322}" y="36" font-family="${FONT}" font-size="13" fill="${C.muted}">Trade</text>

  <!-- Sign-in corner -->
  <text x="${w - 156}" y="36" font-family="${FONT}" font-size="13" fill="${C.muted}">Sign in</text>
  <rect x="${w - 96}" y="14" width="64" height="28" rx="6" fill="${C.text}"/>
  <text x="${w - 64}" y="33" font-family="${FONT}" font-size="13" fill="${C.bg}" text-anchor="middle" font-weight="500">Sign up</text>

  <!-- Hero copy (left) -->
  <text x="${padX}" y="156" font-family="${FONT}" font-size="11" fill="${C.cta}" font-weight="700" letter-spacing="1.5">DYNASTY FANTASY VALUES, CALIBRATED TO YOUR LEAGUE</text>
  <text x="${padX}" y="216" font-family="${FONT}" font-size="40" fill="${C.text}" font-weight="700">Stop guessing</text>
  <text x="${padX}" y="266" font-family="${FONT}" font-size="40" fill="${C.text}" font-weight="700">whether to trade.</text>
  <text x="${padX}" y="316" font-family="${FONT}" font-size="17" fill="${C.muted}">Pylon scores every dynasty player on production,</text>
  <text x="${padX}" y="340" font-family="${FONT}" font-size="17" fill="${C.muted}">age curve, and opportunity — then tells you when</text>
  <text x="${padX}" y="364" font-family="${FONT}" font-size="17" fill="${C.muted}">to sell, who to target, and which trades move</text>
  <text x="${padX}" y="388" font-family="${FONT}" font-size="17" fill="${C.muted}">your team.</text>

  <!-- CTAs -->
  <rect x="${padX}" y="430" width="184" height="44" rx="6" fill="${C.cta}"/>
  <text x="${padX + 92}" y="458" font-family="${FONT}" font-size="14" fill="${C.text}" font-weight="600" text-anchor="middle">Create free account</text>
  <rect x="${padX + 196}" y="430" width="178" height="44" rx="6" fill="none" stroke="${C.border}" stroke-width="1"/>
  <text x="${padX + 285}" y="458" font-family="${FONT}" font-size="14" fill="${C.text}" font-weight="500" text-anchor="middle">See Pro — $7/mo</text>

  <text x="${padX}" y="500" font-family="${FONT}" font-size="12" fill="${C.faint}">Free includes the full PYV board, rookie rankings,</text>
  <text x="${padX}" y="520" font-family="${FONT}" font-size="12" fill="${C.faint}">and one synced Sleeper league. No credit card.</text>

  <!-- Rankings card (right) -->
  <rect x="${cardX}" y="${cardY}" width="${cardW}" height="${cardH}" rx="12" fill="${C.card}" stroke="${C.border}" stroke-width="1"/>
  <text x="${cardX + 24}" y="${cardY + 36}" font-family="${FONT}" font-size="11" fill="${C.faint}" font-weight="700" letter-spacing="1.5">DYNASTY RANKINGS · HALF PPR</text>
  <text x="${cardX + 24}" y="${cardY + 60}" font-family="${FONT}" font-size="20" fill="${C.text}" font-weight="700">Top values right now</text>

  <!-- Column headers -->
  <text x="${cardX + 24}" y="${rowStartY - 12}" font-family="${FONT}" font-size="10" fill="${C.faint}" font-weight="700" letter-spacing="1">#</text>
  <text x="${colName}" y="${rowStartY - 12}" font-family="${FONT}" font-size="10" fill="${C.faint}" font-weight="700" letter-spacing="1">PLAYER</text>
  <text x="${colPyv}" y="${rowStartY - 12}" font-family="${FONT}" font-size="10" fill="${C.faint}" font-weight="700" letter-spacing="1" text-anchor="end">PYV</text>
  <line x1="${cardX + 24}" y1="${rowStartY - 4}" x2="${cardX + cardW - 24}" y2="${rowStartY - 4}" stroke="${C.border}" stroke-width="1"/>

  ${rowsSvg}
</svg>`;
}

function buildNarrowSvg(): string {
  const w = 1080;
  const h = 1920;
  const headerH = 100;
  const padX = 56;

  const cardY = 760;
  const cardW = w - padX * 2;
  const rowStartY = cardY + 152;
  const rowH = 124;

  const rowsSvg = ROWS.slice(0, 7)
    .map((r, i) => {
      const y = rowStartY + i * rowH;
      return `
    <text x="${padX + 32}" y="${y + 38}" font-family="${FONT}" font-size="22" fill="${C.faint}" font-weight="500">${i + 1}</text>
    <text x="${padX + 100}" y="${y + 32}" font-family="${FONT}" font-size="26" fill="${C.text}" font-weight="600">${escapeXml(r.name)}</text>
    <text x="${padX + 100}" y="${y + 64}" font-family="${FONT}" font-size="18" fill="${C.faint}">${r.pos} · ${r.team}</text>
    <text x="${w - padX - 32}" y="${y + 42}" font-family="${FONT}" font-size="26" fill="${C.emerald}" font-weight="600" text-anchor="end">${r.pyv}</text>
    ${i < 6 ? `<line x1="${padX + 32}" y1="${y + 96}" x2="${w - padX - 32}" y2="${y + 96}" stroke="${C.border}" stroke-width="1"/>` : ""}`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${C.bg}"/>

  <!-- Header -->
  <rect width="${w}" height="${headerH}" fill="${C.card}"/>
  <line x1="0" y1="${headerH}" x2="${w}" y2="${headerH}" stroke="${C.border}" stroke-width="1"/>
  ${pylonWordmark(padX, 66, 36)}

  <!-- Hero -->
  <text x="${padX}" y="240" font-family="${FONT}" font-size="18" fill="${C.cta}" font-weight="700" letter-spacing="2.5">DYNASTY VALUES</text>
  <text x="${padX}" y="280" font-family="${FONT}" font-size="18" fill="${C.cta}" font-weight="700" letter-spacing="2.5">CALIBRATED TO YOUR LEAGUE</text>
  <text x="${padX}" y="380" font-family="${FONT}" font-size="68" fill="${C.text}" font-weight="700">Stop guessing</text>
  <text x="${padX}" y="460" font-family="${FONT}" font-size="68" fill="${C.text}" font-weight="700">whether to trade.</text>
  <text x="${padX}" y="540" font-family="${FONT}" font-size="26" fill="${C.muted}">Pylon scores every dynasty</text>
  <text x="${padX}" y="576" font-family="${FONT}" font-size="26" fill="${C.muted}">player on production, age, and</text>
  <text x="${padX}" y="612" font-family="${FONT}" font-size="26" fill="${C.muted}">opportunity.</text>

  <!-- CTA -->
  <rect x="${padX}" y="660" width="${w - padX * 2}" height="68" rx="10" fill="${C.cta}"/>
  <text x="${w / 2}" y="704" font-family="${FONT}" font-size="22" fill="${C.text}" font-weight="600" text-anchor="middle">Create free account</text>

  <!-- Rankings card -->
  <rect x="${padX}" y="${cardY}" width="${cardW}" height="${h - cardY - 80}" rx="20" fill="${C.card}" stroke="${C.border}" stroke-width="1"/>
  <text x="${padX + 32}" y="${cardY + 60}" font-family="${FONT}" font-size="18" fill="${C.faint}" font-weight="700" letter-spacing="2">DYNASTY RANKINGS · HALF PPR</text>
  <text x="${padX + 32}" y="${cardY + 108}" font-family="${FONT}" font-size="32" fill="${C.text}" font-weight="700">Top values right now</text>
  <line x1="${padX + 32}" y1="${cardY + 130}" x2="${w - padX - 32}" y2="${cardY + 130}" stroke="${C.border}" stroke-width="1"/>

  ${rowsSvg}
</svg>`;
}

// Minimal escape for XML text content. Names like "Ja'Marr Chase"
// contain a single quote which is fine inside an SVG text node, but
// any future entry with & or < would break the parse.
function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function main() {
  console.log("Generating PWA screenshots:");

  const wideSvg = buildWideSvg();
  await sharp(Buffer.from(wideSvg)).png().toFile(path.join(OUT, "wide.png"));
  console.log("  wide.png    (1280×720, form_factor=wide)");

  const narrowSvg = buildNarrowSvg();
  await sharp(Buffer.from(narrowSvg))
    .png()
    .toFile(path.join(OUT, "narrow.png"));
  console.log("  narrow.png  (1080×1920, form_factor=narrow)");

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
