/**
 * Color science for the visual stock counter — sRGB → CIELab, a region's color
 * signature, and masking an image by that signature.
 *
 * Lab is chosen over raw RGB distance because shelf photos move with the
 * light: the same paper cup is warm-white under incandescent light and blueish
 * in daylight shade. Lab's L (lightness) separates brightness from chroma, and
 * euclidean distance in Lab approximates perceived difference far better than
 * RGB, so one tolerance works across lighting that would need three in RGB.
 *
 * A `ColorSignature` is the mean and per-channel spread of a region — the
 * region the operator tagged as "one unit of this item". The spread lets the
 * mask tolerance scale with how textured the item is: a glossy single-color
 * lid gets a tight signature, a printed carton a wide one.
 */

import type { VisionImage, Box } from "./image";

/** One Lab color: L in 0..100, a/b roughly -128..127. */
export type Lab = readonly [number, number, number];

export interface ColorSignature {
  mean: Lab;
  /** Per-channel standard deviation of the sampled region (always ≥ 0). */
  spread: Lab;
}

// sRGB → linear → XYZ (D65) → Lab. Constants per the classic formulas; the
// exact white point doesn't matter for *relative* matching, only consistency.
function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function labF(t: number): number {
  return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
}

/** sRGB (0..255 each) → CIELab. Pure; called per-pixel only on sampled sets. */
export function rgbToLab(r: number, g: number, b: number): Lab {
  const rl = srgbToLinear(r);
  const gl = srgbToLinear(g);
  const bl = srgbToLinear(b);
  // sRGB matrix rows for D65.
  const x = (rl * 0.4124 + gl * 0.3576 + bl * 0.1805) / 0.95047;
  const y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722;
  const z = (rl * 0.0193 + gl * 0.1192 + bl * 0.9505) / 1.08883;
  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** Euclidean distance in Lab (a ΔE approximation — good enough for gating). */
export function labDistance(a: Lab, b: Lab): number {
  const dl = a[0] - b[0];
  const da = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * The signature of a region: mean and spread of Lab over a strided sample.
 * Striding (never more than ~4,000 samples) keeps a full-frame tag as cheap as
 * a small one; the statistics don't need every pixel.
 */
export function signatureFromRegion(image: VisionImage, region: Box): ColorSignature | null {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.round(region.x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.round(region.y)));
  const x1 = Math.max(x0, Math.min(image.width, Math.round(region.x + region.w)));
  const y1 = Math.max(y0, Math.min(image.height, Math.round(region.y + region.h)));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w <= 0 || h <= 0) return null;

  const pixels = w * h;
  const step = Math.max(1, Math.floor(Math.sqrt(pixels / 4000)));
  const ls: number[] = [];
  const as: number[] = [];
  const bs: number[] = [];
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const p = (y * image.width + x) * 4;
      const lab = rgbToLab(image.data[p], image.data[p + 1], image.data[p + 2]);
      ls.push(lab[0]);
      as.push(lab[1]);
      bs.push(lab[2]);
    }
  }
  if (ls.length === 0) return null;

  function stats(values: number[]): [number, number] {
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / values.length;
    let variance = 0;
    for (const v of values) variance += (v - mean) * (v - mean);
    return [mean, Math.sqrt(variance / values.length)];
  }

  const [lm, lsSpread] = stats(ls);
  const [am, asSpread] = stats(as);
  const [bm, bsSpread] = stats(bs);
  return {
    mean: [lm, am, bm],
    spread: [lsSpread, asSpread, bsSpread],
  };
}

/** Average Lab inside a small square window — the seed for tap-to-tag. */
export function medianLabInWindow(image: VisionImage, cx: number, cy: number, radius: number): Lab | null {
  const x0 = Math.max(0, Math.round(cx - radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const x1 = Math.min(image.width, Math.round(cx + radius) + 1);
  const y1 = Math.min(image.height, Math.round(cy + radius) + 1);
  const labs: Lab[] = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * image.width + x) * 4;
      labs.push(rgbToLab(image.data[p], image.data[p + 1], image.data[p + 2]));
    }
  }
  if (labs.length === 0) return null;
  // A median per channel resists a highlight or shadow pixel inside the window.
  function median(values: number[]): number {
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
  }
  return [
    median(labs.map((l) => l[0])),
    median(labs.map((l) => l[1])),
    median(labs.map((l) => l[2])),
  ];
}

/**
 * Default tolerance model: three standard deviations of the tagged region's own
 * spread, clamped to a sane band. A tight signature (solid-color item) still
 * gets a minimum working tolerance — real photos have sensor noise and JPEG
 * blocking even on flat plastic — and a wildly textured one is capped so it
 * doesn't swallow the whole shelf.
 */
export function defaultTolerance(signature: ColorSignature): number {
  const spread = (signature.spread[0] + signature.spread[1] + signature.spread[2]) / 3;
  return Math.max(10, Math.min(34, 3 * spread + 8));
}

/**
 * Marks every pixel within `tolerance` (Lab distance) of the signature.
 * Returns a w*h mask of 0/1 bytes. This is the workhorse of the color
 * strategy: items with a distinctive color read as one bright island each.
 */
export function maskBySignature(
  image: VisionImage,
  signature: ColorSignature,
  tolerance: number,
): Uint8Array {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  const [ml, ma, mb] = signature.mean;
  const t2 = tolerance * tolerance;
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const lab = rgbToLab(data[p], data[p + 1], data[p + 2]);
    const dl = lab[0] - ml;
    const da = lab[1] - ma;
    const db = lab[2] - mb;
    if (dl * dl + da * da + db * db <= t2) mask[i] = 1;
  }
  return mask;
}
