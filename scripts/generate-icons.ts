/**
 * Regenerates the PNG/ICO icon assets from public/icon.svg and
 * public/icon-square.svg. Run this whenever the source SVGs change:
 *
 *   npx tsx scripts/generate-icons.ts
 *
 * Why this exists: the PWA manifest previously shipped a single SVG icon.
 * Chrome/Edge's installability check wants a real PNG icon set — without one,
 * "Install app" can silently fall back to a browser "shortcut" that keeps the
 * address bar instead of a true standalone install. Maskable icons also need
 * a full-bleed (non-rounded) source so the OS can crop them into any shape
 * without exposing transparent corners, which is why icon-square.svg exists
 * alongside the rounded icon.svg used for the "any" purpose and favicon.
 *
 * The generated windows/cafe-pos.ico also supplies the same platform mark to
 * legacy Windows launchers and the current Business Suite desktop installer.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const ROOT = join(__dirname, "..");
const ICON_SVG = join(ROOT, "public/icon.svg");
const ICON_SQUARE_SVG = join(ROOT, "public/icon-square.svg");

async function renderPng(svgPath: string, size: number): Promise<Buffer> {
  return sharp(svgPath).resize(size, size).png().toBuffer();
}

/** Minimal ICO container: header + directory entries + raw PNG frames (Windows Vista+). */
function buildIco(frames: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(frames.length, 4);

  const dirEntries: Buffer[] = [];
  const imageData: Buffer[] = [];
  let offset = 6 + frames.length * 16;

  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // color palette
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // image data size
    entry.writeUInt32LE(offset, 12); // offset
    dirEntries.push(entry);
    imageData.push(png);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...imageData]);
}

async function main() {
  const [icon192, icon512, appleTouch180, maskable512] = await Promise.all([
    renderPng(ICON_SVG, 192),
    renderPng(ICON_SVG, 512),
    renderPng(ICON_SQUARE_SVG, 180),
    renderPng(ICON_SQUARE_SVG, 512),
  ]);

  writeFileSync(join(ROOT, "public/icon-192.png"), icon192);
  writeFileSync(join(ROOT, "public/icon-512.png"), icon512);
  writeFileSync(join(ROOT, "public/apple-touch-icon.png"), appleTouch180);
  writeFileSync(join(ROOT, "public/icon-maskable-512.png"), maskable512);

  const icoSizes = [16, 32, 48, 64, 128, 256];
  const icoFrames = await Promise.all(
    icoSizes.map(async (size) => ({ size, png: await renderPng(ICON_SVG, size) })),
  );
  const ico = buildIco(icoFrames);
  writeFileSync(join(ROOT, "windows/cafe-pos.ico"), ico);
  // Browsers still request /favicon.ico even when the metadata points at the
  // SVG/PNG set; serving the same ICO from public/ answers that request with
  // the real icon instead of a 404.
  writeFileSync(join(ROOT, "public/favicon.ico"), ico);

  console.log("Generated: public/icon-192.png, public/icon-512.png, public/apple-touch-icon.png,");
  console.log("           public/icon-maskable-512.png, public/favicon.ico, windows/cafe-pos.ico");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
