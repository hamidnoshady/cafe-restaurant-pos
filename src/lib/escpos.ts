/**
 * ESC/POS command building — pure functions, Buffer in/out, no I/O.
 *
 * Receipts and kitchen tickets are Persian/RTL, which ESC/POS printers can't
 * shape or reorder in text mode (no printer we could target ships a correct
 * Farsi codepage + BiDi engine). Instead the print agent (print-agent/)
 * renders the HTML template with a real browser engine (correct shaping),
 * screenshots it, and this module packs the resulting bitmap into the
 * universal `GS v 0` raster command — supported by virtually every
 * ESC/POS-compatible printer regardless of brand or firmware Persian
 * support. Text-mode commands here are only used for the cut/drawer/feed
 * control bytes, which are ASCII-only protocol framing, not content.
 */

export const ESC = 0x1b;
export const GS = 0x1d;

/** ESC @ — reset the printer to its power-on state. */
export function initPrinter(): Buffer {
  return Buffer.from([ESC, 0x40]);
}

/** ESC d n — print and feed n lines. */
export function lineFeed(lines = 1): Buffer {
  const n = Math.max(0, Math.min(255, Math.round(lines)));
  return Buffer.from([ESC, 0x64, n]);
}

/** GS V m — full cut (m=0) or partial cut (m=1, leaves a tab so the receipt doesn't fall). */
export function cutPaper(partial = true): Buffer {
  return Buffer.from([GS, 0x56, partial ? 0x01 : 0x00]);
}

/**
 * ESC p m t1 t2 — fire the cash drawer kick-out pin. `pin` selects the
 * connector (0 = the common one on the printer's RJ11 port); on/off times
 * are in 2ms units per the ESC/POS spec, clamped to the 1-byte range.
 */
export function openDrawerPin(pin: 0 | 1 = 0, onMs = 25, offMs = 250): Buffer {
  const clamp = (ms: number) => Math.max(1, Math.min(255, Math.round(ms / 2)));
  return Buffer.from([ESC, 0x70, pin, clamp(onMs), clamp(offMs)]);
}

export interface MonochromeRaster {
  /** bytes per row = ceil(width / 8) */
  widthBytes: number;
  heightPx: number;
  /** widthBytes * heightPx, MSB-first per row, 1 bit = printed (black) dot */
  data: Uint8Array;
}

/**
 * Threshold an 8-bit grayscale pixel buffer (row-major, one byte 0-255 per
 * pixel, 0 = black) into a 1-bit ESC/POS raster. Width is padded up to a
 * multiple of 8 with white (unset) bits.
 */
export function packMonochromeRaster(
  pixels: Uint8Array,
  width: number,
  height: number,
  threshold = 128,
): MonochromeRaster {
  const widthBytes = Math.ceil(width / 8);
  const data = new Uint8Array(widthBytes * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const rowByteOffset = y * widthBytes;
    for (let x = 0; x < width; x++) {
      if (pixels[rowOffset + x] < threshold) {
        data[rowByteOffset + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return { widthBytes, heightPx: height, data };
}

/** Most controllers cap how many raster rows they'll buffer per `GS v 0` call; split into safe chunks. */
const MAX_RASTER_CHUNK_ROWS = 256;

/** GS v 0 — one or more raster-image commands covering the whole bitmap, top to bottom. */
export function rasterImageCommands(raster: MonochromeRaster, maxChunkRows = MAX_RASTER_CHUNK_ROWS): Buffer[] {
  const chunks: Buffer[] = [];
  for (let y = 0; y < raster.heightPx; y += maxChunkRows) {
    const rows = Math.min(maxChunkRows, raster.heightPx - y);
    const header = Buffer.from([
      GS,
      0x76,
      0x30,
      0x00,
      raster.widthBytes & 0xff,
      (raster.widthBytes >> 8) & 0xff,
      rows & 0xff,
      (rows >> 8) & 0xff,
    ]);
    const slice = Buffer.from(raster.data.subarray(y * raster.widthBytes, (y + rows) * raster.widthBytes));
    chunks.push(Buffer.concat([header, slice]));
  }
  return chunks;
}

/** Assembles the full byte stream for one print job: init, image, feed, optional cut/drawer kick. */
export function buildPrintJob(
  raster: MonochromeRaster,
  opts: { cut?: boolean; feedLines?: number; kickDrawer?: boolean } = {},
): Buffer {
  const parts: Buffer[] = [initPrinter()];
  if (opts.kickDrawer) parts.push(openDrawerPin());
  parts.push(...rasterImageCommands(raster));
  parts.push(lineFeed(opts.feedLines ?? 3));
  if (opts.cut !== false) parts.push(cutPaper(true));
  return Buffer.concat(parts);
}

/** Drawer-only job (no printing) — used by the standalone "test drawer" action. */
export function buildDrawerKickJob(pin: 0 | 1 = 0): Buffer {
  return Buffer.concat([initPrinter(), openDrawerPin(pin)]);
}
