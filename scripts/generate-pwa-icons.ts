/**
 * Generate PWA icons from the existing Pylon logo.
 *
 * The source logo at src/app/icon.png is 314×228 (non-square). PWA
 * manifests require square icons at 192×192 and 512×512, plus a 180×180
 * apple-touch-icon for iOS home-screen installs. Maskable icons get
 * extra ~20% padding so platform-defined shape masks (Android adaptive
 * icons) don't crop the glyph.
 *
 * Run once after the source logo changes:
 *   npx tsx scripts/generate-pwa-icons.ts
 */
import sharp from "sharp";
import path from "node:path";

const SRC = path.join(process.cwd(), "src/app/icon.png");
const OUT = path.join(process.cwd(), "public");

// Brand background — same near-black as the source logo's bake-in fill
// so the glyph blends seamlessly when platforms ignore alpha.
const BG = { r: 9, g: 9, b: 11, alpha: 1 };

async function makeIcon(size: number, filename: string, padding = 0.12) {
  // Reserve `padding` of the canvas as breathing room. For maskable
  // icons this is 20%+ so the platform's circular/squircle mask stays
  // inside the glyph; for "any" icons 12% is enough to keep it from
  // touching the edge.
  const inner = Math.round(size * (1 - padding * 2));
  const buf = await sharp(SRC)
    .resize(inner, inner, { fit: "contain", background: BG })
    .toBuffer();

  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BG,
    },
  })
    .composite([{ input: buf, gravity: "center" }])
    .png()
    .toFile(path.join(OUT, filename));

  console.log(`  ${filename}  (${size}×${size}, ${Math.round(padding * 100)}% padding)`);
}

async function main() {
  console.log("Generating PWA icons:");
  await makeIcon(192, "icon-192.png", 0.12);
  await makeIcon(512, "icon-512.png", 0.12);
  await makeIcon(192, "icon-maskable-192.png", 0.22);
  await makeIcon(512, "icon-maskable-512.png", 0.22);
  await makeIcon(180, "apple-icon.png", 0.1);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
