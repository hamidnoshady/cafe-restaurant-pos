/**
 * Pure image plumbing for the visual stock counter (Phase 47 — شمارش تصویری).
 *
 * A `VisionImage` is a plain RGBA byte buffer plus its dimensions — deliberately
 * *not* a canvas or a DOM type — so every algorithm in `src/lib/vision/` is a
 * pure function over bytes that runs identically in the browser (drawn from a
 * camera frame or a decoded photo) and in a unit test (drawn from a synthetic
 * fixture). No dependency on OpenCV/WASM: the counting techniques here are the
 * classical ones (color masking, morphology, connected components, gradient
 * Hough circles) and are small enough to own, test and debug as TypeScript.
 *
 * Coordinates are pixel-space with (0,0) at the top-left of the *image* — the
 * DOM may be RTL, canvas drawing never is. Boxes handed to and from these
 * modules are always in image pixels; the normalized (0..1) form is used only
 * at the storage boundary (a visual profile's region and a count scan's boxes
 * are stored as fractions so they survive re-scaling between devices).
 */

/** An RGBA raster. `data.length === width * height * 4`. */
export interface VisionImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** A rectangle in image pixel space. `w`/`h` are sizes, not edges. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangle as fractions of the image (0..1) — the storage/wire form. */
export interface NormalizedBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function normalizeBox(box: Box, image: { width: number; height: number }): NormalizedBox {
  return {
    x: image.width > 0 ? box.x / image.width : 0,
    y: image.height > 0 ? box.y / image.height : 0,
    w: image.width > 0 ? box.w / image.width : 0,
    h: image.height > 0 ? box.h / image.height : 0,
  };
}

/** Re-scales a normalized box into pixel space, clamped inside the image. */
export function denormalizeBox(
  box: NormalizedBox,
  image: { width: number; height: number },
): Box {
  const x = Math.max(0, Math.min(image.width, Math.round(box.x * image.width)));
  const y = Math.max(0, Math.min(image.height, Math.round(box.y * image.height)));
  const w = Math.max(0, Math.min(image.width - x, Math.round(box.w * image.width)));
  const h = Math.max(0, Math.min(image.height - y, Math.round(box.h * image.height)));
  return { x, y, w, h };
}

/** The pixel area of a box, floored at zero so an empty box can't go negative. */
export function boxArea(box: Box): number {
  return Math.max(0, box.w) * Math.max(0, box.h);
}

/** Area ratio of a box against the whole image — how much of the frame it fills. */
export function boxAreaRatio(box: Box, image: { width: number; height: number }): number {
  const total = image.width * image.height;
  return total > 0 ? boxArea(box) / total : 0;
}

/** 8-bit luminance of an RGBA image (Rec. 601 luma — the standard gray). */
export function toGrayscale(image: VisionImage): Uint8Array {
  const out = new Uint8Array(image.width * image.height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (image.data[p] * 299 + image.data[p + 1] * 587 + image.data[p + 2] * 114) / 1000;
  }
  return out;
}
