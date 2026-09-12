/**
 * Binary morphology for the visual stock counter — erode, dilate and the
 * opening (erode→dilate) the color mask needs before connected-component
 * labeling.
 *
 * Why opening matters here: a color mask over a photo of real packaging is
 * never clean. Glossy plastic throws specular highlights that punch holes in
 * blobs, and the shelf behind picks up enough bounce light to grow salt noise
 * around every item. A single erode removes the salt and the thin color-bleed
 * bridges between touching items; the dilate that follows grows the survivors
 * back toward their original outline. One iteration each is the sweet spot for
 * analysis-resolution photos (the browser glue downscales to ≤640px before any
 * of this runs); more iterations would start eating genuinely small items.
 *
 * Masks are `Uint8Array` of 0/1 in row-major order, the same layout the color
 * masker emits and the component labeler consumes.
 */

export type BinaryMask = Uint8Array;

interface MaskGrid {
  width: number;
  height: number;
}

/** True where at least one of the 8 neighbours (and the pixel itself) is set. */
export function dilate(mask: BinaryMask, { width, height }: MaskGrid): BinaryMask {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x;
      if (mask[i]) {
        out[i] = 1;
        continue;
      }
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if (mask[ny * width + nx]) {
            hit = 1;
            break;
          }
        }
      }
      out[i] = hit;
    }
  }
  return out;
}

/** True only where the pixel and all 8 neighbours are set (shrinks blobs). */
export function erode(mask: BinaryMask, { width, height }: MaskGrid): BinaryMask {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    for (let x = 0; x < width; x++) {
      const i = rowStart + x;
      if (!mask[i]) continue;
      let all = 1;
      for (let dy = -1; dy <= 1 && all; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) {
          all = 0;
          break;
        }
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) {
            all = 0;
            break;
          }
          if (!mask[ny * width + nx]) {
            all = 0;
            break;
          }
        }
      }
      out[i] = all;
    }
  }
  return out;
}

/** Erode then dilate: removes salt noise and thin bridges, keeps blob shapes. */
export function openMask(mask: BinaryMask, grid: MaskGrid, iterations = 1): BinaryMask {
  let current = mask;
  for (let i = 0; i < iterations; i++) current = erode(current, grid);
  for (let i = 0; i < iterations; i++) current = dilate(current, grid);
  return current;
}
