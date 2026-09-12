/**
 * Circle detection for the visual stock counter — a gradient-direction Hough
 * transform, the classical technique for "how many round things are in this
 * photo" (cups, lids, cans and plates photographed from above).
 *
 * How it works, and why this shape of it:
 *
 *   1. A Sobel pass gives every pixel a gradient vector. Thresholding the
 *      magnitude (adaptive: mean + k·σ of the whole image) keeps only real
 *      edges, not JPEG noise.
 *   2. A circle's edge gradient points along its radius — straight at or away
 *      from the center. So instead of the naive 3D Hough (every pixel voting
 *      for every point of every sphere), each edge pixel votes only *along its
 *      gradient line*, once per candidate radius, in both directions (we can't
 *      know the polarity — bright-on-dark or dark-on-bright — without guessing).
 *      That is O(edges × radii) instead of O(pixels × radii³) and it is why
 *      this runs in plain JavaScript at camera-frame rates.
 *   3. Peaks in each radius's accumulator are candidate centers. The score is
 *      the fraction of the circumference that voted for it, so it is
 *      scale-independent (0.35 means a third of the rim agreed).
 *   4. Non-maximum suppression across radii kills the same physical circle
 *      being reported at three neighbouring radii.
 *
 * The counter (count.ts) clusters the survivors by radius and counts the
 * dominant cluster, because the item being counted is one physical size — a
 * cluster of many equal-radius circles *is* the shelf of cups.
 */

import { toGrayscale, type VisionImage } from "./image";

export interface DetectedCircle {
  cx: number;
  cy: number;
  r: number;
  /** 0..1 — votes as a fraction of the circumference. */
  score: number;
}

export interface CircleDetectionOptions {
  minRadius: number;
  maxRadius: number;
  /** Gradient magnitude threshold; when omitted, derived from the image. */
  edgeThreshold?: number;
}

/**
 * Radii to sweep: geometric growth (~7% steps) from min to max. Linear steps
 * would waste most of the sweep at large radii, where a 1px difference is
 * meaningless; geometric steps give uniform *relative* resolution.
 */
export function radiusSweep(minRadius: number, maxRadius: number): number[] {
  const out: number[] = [];
  for (let r = Math.max(2, Math.floor(minRadius)); r <= maxRadius; r = Math.max(r + 1, Math.ceil(r * 1.07))) {
    out.push(r);
  }
  return out;
}

/** Sobel gradients over the grayscale image; returns gx/gy as Int16 arrays. */
function sobel(gray: Uint8Array, width: number, height: number): { gx: Int16Array; gy: Int16Array } {
  const gx = new Int16Array(width * height);
  const gy = new Int16Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = gray[i - width - 1];
      const t = gray[i - width];
      const tr = gray[i - width + 1];
      const l = gray[i - 1];
      const r = gray[i + 1];
      const bl = gray[i + width - 1];
      const b = gray[i + width];
      const br = gray[i + width + 1];
      gx[i] = tr + 2 * r + br - tl - 2 * l - bl;
      gy[i] = bl + 2 * b + br - tl - 2 * t - tr;
    }
  }
  return { gx, gy };
}

/**
 * Adaptive edge threshold: mean + 1.5σ of gradient magnitude, floored at 24.
 * The floor stays below a faint-but-real rim (a white cup on a pale shelf is
 * an ~8-gray-level step, a Sobel response of ~31) and above JPEG sensor noise
 * (~±4 gray levels → response ~16), which is the band it has to discriminate.
 */
function deriveEdgeThreshold(mag: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < mag.length; i++) sum += mag[i];
  const mean = sum / mag.length;
  let variance = 0;
  for (let i = 0; i < mag.length; i++) variance += (mag[i] - mean) * (mag[i] - mean);
  const std = Math.sqrt(variance / mag.length);
  return Math.max(24, mean + 1.5 * std);
}

export function detectCircles(image: VisionImage, options: CircleDetectionOptions): DetectedCircle[] {
  const { width, height } = image;
  if (width < 8 || height < 8) return [];
  const maxRadius = Math.min(options.maxRadius, Math.floor(Math.min(width, height) / 2) - 1);
  const minRadius = Math.min(options.minRadius, maxRadius);
  if (minRadius < 2 || maxRadius <= minRadius) return [];

  const gray = toGrayscale(image);
  const { gx, gy } = sobel(gray, width, height);
  const mag = new Float32Array(width * height);
  for (let i = 0; i < mag.length; i++) {
    mag[i] = Math.hypot(gx[i], gy[i]);
  }
  const threshold = options.edgeThreshold ?? deriveEdgeThreshold(mag);

  const radii = radiusSweep(minRadius, maxRadius);
  const accumulator = new Int32Array(width * height);
  const candidates: DetectedCircle[] = [];

  for (const r of radii) {
    accumulator.fill(0);
    for (let y = 1; y < height - 1; y++) {
      const row = y * width;
      for (let x = 1; x < width - 1; x++) {
        const i = row + x;
        const m = mag[i];
        if (m < threshold) continue;
        const ux = gx[i] / m;
        const uy = gy[i] / m;
        // Both polarities: gradient points at or away from the center.
        for (const sign of [1, -1]) {
          const vx = x + sign * r * ux;
          const vy = y + sign * r * uy;
          // Vote into the 3×3 block around the target, not one pixel: a
          // discrete 3×3 Sobel's direction is off the true radial by a few
          // degrees, and over a 20px radius that already smears the landing
          // point across ~2px. Block voting lets the consensus of all rim
          // angles pile onto the true center instead of ringing it — the
          // difference between a sharp peak and no peak at all (verified on
          // synthetic rims, where it concentrated ~4× the single-pixel vote).
          const bx = Math.round(vx);
          const by = Math.round(vy);
          for (let dy = -1; dy <= 1; dy++) {
            const iy = by + dy;
            if (iy < 0 || iy >= height) continue;
            for (let dx = -1; dx <= 1; dx++) {
              const ix = bx + dx;
              if (ix < 0 || ix >= width) continue;
              accumulator[iy * width + ix]++;
            }
          }
        }
      }
    }

    const circumference = 2 * Math.PI * r;
    // A rim must be at least ~14% closed and at least 5 agreeing edge pixels
    // to count — enough to reject noise arcs, low enough for partially shaded
    // or slightly occluded rims in real photos.
    const minVotes = Math.max(5, Math.ceil(circumference * 0.14));
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const votes = accumulator[row + x];
        if (votes < minVotes) continue;
        // Local maximum in a 5×5 window of this radius slice: split peaks are
        // one circle, not two adjacent ones.
        let isPeak = true;
        for (let dy = -2; dy <= 2 && isPeak; dy++) {
          const ny = y + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            if (nx < 0 || nx >= width) continue;
            if (accumulator[ny * width + nx] > votes) {
              isPeak = false;
              break;
            }
          }
        }
        // Score floor: a true rim's consensus lands well above this (0.5–1.1
        // in calibration), while the arcs of straight edges and quarter-rim
        // artifacts sit at or below it. Calibrated on synthetic rims.
        if (isPeak && votes / circumference >= 0.32) {
          candidates.push({ cx: x, cy: y, r, score: votes / circumference });
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const accepted: DetectedCircle[] = [];
  for (const c of candidates) {
    const clash = accepted.some(
      (a) =>
        Math.hypot(a.cx - c.cx, a.cy - c.cy) < 0.75 * Math.max(a.r, c.r) &&
        a.r / c.r <= 1.7 &&
        c.r / a.r <= 1.7,
    );
    if (!clash) accepted.push(c);
  }
  // Stable output: score first (the operator's overlay cares about the
  // strongest detections), then position as the tiebreaker.
  accepted.sort((a, b) => b.score - a.score || (a.cy - b.cy) || (a.cx - b.cx) || (a.r - b.r));
  return accepted;
}
