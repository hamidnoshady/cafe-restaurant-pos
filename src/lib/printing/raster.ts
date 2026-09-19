/**
 * Decodes a PNG screenshot into the flat 8-bit grayscale buffer
 * src/lib/escpos.ts's packMonochromeRaster expects. Pure (pngjs only).
 */
import { PNG } from "pngjs";

export interface GrayscaleImage {
  width: number;
  height: number;
  /** row-major, one byte 0-255 per pixel */
  pixels: Uint8Array;
}

export function decodePngToGrayscale(buffer: Buffer): GrayscaleImage {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png; // RGBA, straight (non-premultiplied) alpha
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3] / 255;
    // Composite over a white receipt background before taking luminance,
    // so a transparent screenshot background doesn't print as solid black.
    const rr = r * a + 255 * (1 - a);
    const gg = g * a + 255 * (1 - a);
    const bb = b * a + 255 * (1 - a);
    pixels[i] = Math.round(0.299 * rr + 0.587 * gg + 0.114 * bb);
  }
  return { width, height, pixels };
}
