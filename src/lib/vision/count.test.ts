/**
 * Unit tests for the pure counting engine — synthetic RGBA fixtures, no DOM,
 * no canvas, no network. Every fixture draws the situation the strategy is
 * for (distinct colored units, merged piles, rows of circles) at a small
 * analysis-like resolution, tags one unit the way the operator would, and
 * asserts the engine's count, confidence band and box count.
 *
 * These are the tests that keep the counter honest without a camera: if a
 * refactor of masking, morphology, labeling or Hough changes what a clean
 * photo counts as, a red line here names it.
 */
import { describe, expect, it } from "vitest";
import type { Box, VisionImage } from "./image";
import { buildProfileFromRegion, countWithProfile, regionAtPoint, unitsInBlob } from "./count";
import { mapBoxThroughContain, mapBoxThroughCover, medianOf, pointFromViewToFrame } from "./overlay";
import { detectCircles, radiusSweep } from "./circles";
import { rgbToLab, labDistance, signatureFromRegion } from "./color";
import { findComponents } from "./components";
import { erode, dilate, openMask } from "./morphology";

const W = 160;
const H = 120;

function makeImage(width = W, height = H, fill: [number, number, number] = [245, 243, 238]): VisionImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < data.length; p += 4) {
    data[p] = fill[0];
    data[p + 1] = fill[1];
    data[p + 2] = fill[2];
    data[p + 3] = 255;
  }
  return { width, height, data };
}

/** Draws a solid rectangle in pixel coordinates (clipped to the image). */
function paintRect(image: VisionImage, box: Box, color: [number, number, number]): void {
  const x0 = Math.max(0, Math.round(box.x));
  const y0 = Math.max(0, Math.round(box.y));
  const x1 = Math.min(image.width, Math.round(box.x + box.w));
  const y1 = Math.min(image.height, Math.round(box.y + box.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * image.width + x) * 4;
      image.data[p] = color[0];
      image.data[p + 1] = color[1];
      image.data[p + 2] = color[2];
      image.data[p + 3] = 255;
    }
  }
}

function paintCircle(
  image: VisionImage,
  cx: number,
  cy: number,
  r: number,
  color: [number, number, number],
): void {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(image.height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(image.width - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) {
        const p = (y * image.width + x) * 4;
        image.data[p] = color[0];
        image.data[p + 1] = color[1];
        image.data[p + 2] = color[2];
        image.data[p + 3] = 255;
      }
    }
  }
}

const CARTON: [number, number, number] = [186, 90, 22];
const SHELF: [number, number, number] = [245, 243, 238];

/** The standard fixture: `n` carton-colored units in a row on a warm shelf. */
function rowOfUnits(n: number, unitH = 20, gap = 8): { image: VisionImage; boxes: Box[] } {
  const image = makeImage();
  const unitW = Math.max(8, Math.min(24, Math.floor((W - 16 - (n - 1) * gap) / n)));
  const boxes: Box[] = [];
  const totalW = n * unitW + (n - 1) * gap;
  let x = Math.floor((W - totalW) / 2);
  for (let i = 0; i < n; i++) {
    const box: Box = { x, y: 50, w: unitW, h: unitH };
    paintRect(image, box, CARTON);
    boxes.push(box);
    x += unitW + gap;
  }
  return { image, boxes };
}

describe("vision color strategy", () => {
  it("counts distinct single units exactly", () => {
    for (const n of [1, 2, 3, 5, 8]) {
      const { image, boxes } = rowOfUnits(n);
      const tag = boxes[0];
      const built = buildProfileFromRegion(image, tag);
      expect(built, `profile should build for ${n} units`).not.toBeNull();
      expect(built!.profile.kind).toBe("color");
      const result = countWithProfile(image, built!.profile);
      expect(result.count, `${n} distinct units`).toBe(n);
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.boxes).toHaveLength(n);
    }
  });

  it("estimates merged touching units by area", () => {
    // Two rows of units with no gap: a pile where blobs touch and merge.
    const image = makeImage();
    paintRect(image, { x: 20, y: 30, w: 100, h: 18 }, CARTON);
    paintRect(image, { x: 20, y: 72, w: 100, h: 18 }, CARTON);
    // Tag: the left fifth of the top row ≈ one unit.
    const built = buildProfileFromRegion(image, { x: 20, y: 30, w: 20, h: 18 });
    expect(built).not.toBeNull();
    const result = countWithProfile(image, built!.profile);
    // Each strip is ~5 units wide; area estimation should land near 10 total.
    expect(result.count).toBeGreaterThanOrEqual(8);
    expect(result.count).toBeLessThanOrEqual(12);
  });

  it("returns zero confidence for an empty shelf", () => {
    const image = makeImage();
    const other = rowOfUnits(3).image;
    const built = buildProfileFromRegion(other, { x: 66, y: 50, w: 24, h: 20 });
    expect(built).not.toBeNull();
    const result = countWithProfile(image, built!.profile);
    expect(result.count).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it("does not count a different-colored item", () => {
    const { image, boxes } = rowOfUnits(4);
    // A competitor's teal carton between ours.
    paintRect(image, { x: 66, y: 90, w: 24, h: 20 }, [22, 128, 124]);
    const built = buildProfileFromRegion(image, boxes[0]);
    const result = countWithProfile(image, built!.profile);
    expect(result.count).toBe(4);
  });

  it("rejects a tag that covers the whole frame or misses it", () => {
    const { image } = rowOfUnits(4);
    expect(buildProfileFromRegion(image, { x: 0, y: 0, w: W, h: H })).toBeNull();
    expect(buildProfileFromRegion(image, { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});

describe("vision round strategy", () => {
  it("counts a row of identical circles", () => {
    for (const n of [1, 3, 6]) {
      const r = 12;
      const spacing = 2 * r + 14;
      const width = Math.max(W, n * spacing + 24);
      const image = makeImage(width, H);
      const startX = width / 2 - ((n - 1) * spacing) / 2;
      for (let i = 0; i < n; i++) paintCircle(image, startX + i * spacing, H / 2, r, [252, 251, 248]);
      const built = buildProfileFromRegion(image, {
        x: startX - r,
        y: H / 2 - r,
        w: 2 * r,
        h: 2 * r,
      });
      expect(built, `round profile should build for ${n} cups`).not.toBeNull();
      expect(built!.profile.kind).toBe("round");
      const result = countWithProfile(image, built!.profile);
      expect(result.count, `${n} circles`).toBe(n);
      expect(result.boxes).toHaveLength(n);
      expect(result.confidence).toBeGreaterThan(0.4);
    }
  });

  it("prefers the dominant equal-size cluster over stray circles", () => {
    const image = makeImage();
    // Four cups and one big plate.
    for (let i = 0; i < 4; i++) paintCircle(image, 25 + i * 34, 40, 12, [252, 251, 248]);
    paintCircle(image, 110, 90, 26, [252, 251, 248]);
    const built = buildProfileFromRegion(image, { x: 13, y: 28, w: 24, h: 24 });
    expect(built).not.toBeNull();
    expect(built!.profile.kind).toBe("round");
    const result = countWithProfile(image, built!.profile);
    expect(result.count).toBe(4);
  });
});

describe("vision tap-to-tag", () => {
  it("finds the unit blob under a tap", () => {
    const { image, boxes } = rowOfUnits(4);
    const target = boxes[2];
    const hit = regionAtPoint(image, target.x + target.w / 2, target.y + target.h / 2);
    expect(hit).not.toBeNull();
    expect(hit!.box.x).toBeGreaterThanOrEqual(target.x - 2);
    expect(hit!.box.x + hit!.box.w).toBeLessThanOrEqual(target.x + target.w + 2);
    // Tagging through the detected blob must also produce a usable profile.
    const built = buildProfileFromRegion(image, hit!.box);
    expect(built).not.toBeNull();
    expect(countWithProfile(image, built!.profile).count).toBe(4);
  });

  it("returns null when the tap lands on the shelf", () => {
    const { image } = rowOfUnits(3);
    expect(regionAtPoint(image, 5, 5)).toBeNull();
  });
});

describe("unitsInBlob", () => {
  it("rounds conservatively around the single-unit area", () => {
    expect(unitsInBlob(100, 100)).toBe(1);
    expect(unitsInBlob(130, 100)).toBe(1); // shading spread — still one
    expect(unitsInBlob(150, 100)).toBe(2); // clearly two areas
    expect(unitsInBlob(310, 100)).toBe(3);
    expect(unitsInBlob(50, 100)).toBe(1); // a small unit is still a unit
  });
});

describe("color science", () => {
  it("black and white are far apart in Lab; a color is near itself", () => {
    const black = rgbToLab(0, 0, 0);
    const white = rgbToLab(255, 255, 255);
    expect(labDistance(black, white)).toBeGreaterThan(60);
    const cup = rgbToLab(252, 251, 248);
    expect(labDistance(cup, rgbToLab(250, 250, 247))).toBeLessThan(3);
  });

  it("a region signature separates the carton from the shelf", () => {
    const { image, boxes } = rowOfUnits(1);
    const carton = signatureFromRegion(image, boxes[0])!;
    const shelf = signatureFromRegion(image, { x: 0, y: 0, w: 40, h: 40 })!;
    expect(labDistance(carton.mean, shelf.mean)).toBeGreaterThan(30);
  });
});

describe("morphology", () => {
  it("opening removes salt noise without eating blobs", () => {
    const mask = new Uint8Array(20 * 20);
    mask[10 * 20 + 10] = 1; // salt
    for (let y = 5; y < 10; y++) for (let x = 5; x < 12; x++) mask[y * 20 + x] = 1;
    const opened = openMask(mask, { width: 20, height: 20 }, 1);
    expect(opened[10 * 20 + 10]).toBe(0); // the salt pixel is gone
    let area = 0;
    for (const v of opened) area += v;
    expect(area).toBeGreaterThan(20); // the real blob survived
  });

  it("erode shrinks and dilate grows", () => {
    const mask = new Uint8Array(10 * 10);
    for (let y = 3; y < 7; y++) for (let x = 3; x < 7; x++) mask[y * 10 + x] = 1;
    const eroded = erode(mask, { width: 10, height: 10 });
    const dilated = dilate(mask, { width: 10, height: 10 });
    const sum = (m: Uint8Array) => m.reduce((a, b) => a + b, 0);
    expect(sum(eroded)).toBeLessThan(sum(mask));
    expect(sum(dilated)).toBeGreaterThan(sum(mask));
  });
});

describe("connected components", () => {
  it("labels separate blobs and merges diagonally-touching ones", () => {
    const mask = new Uint8Array(30 * 10);
    for (let x = 2; x < 6; x++) mask[3 * 30 + x] = 1;
    for (let x = 10; x < 14; x++) mask[5 * 30 + x] = 1;
    // Diagonal touch with the second blob.
    mask[4 * 30 + 9] = 1;
    const blobs = findComponents(mask, { width: 30, height: 10 });
    expect(blobs).toHaveLength(2);
    expect(blobs[0].area).toBeGreaterThan(0);
  });
});

describe("circle detection", () => {
  it("finds a drawn circle near its true center and radius", () => {
    const image = makeImage(120, 120);
    paintCircle(image, 60, 60, 20, [40, 40, 40]);
    const circles = detectCircles(image, { minRadius: 10, maxRadius: 40 });
    expect(circles.length).toBeGreaterThanOrEqual(1);
    const best = circles[0];
    expect(Math.hypot(best.cx - 60, best.cy - 60)).toBeLessThan(4);
    expect(Math.abs(best.r - 20)).toBeLessThanOrEqual(3);
  });

  it("radius sweep grows geometrically and spans the range", () => {
    const radii = radiusSweep(8, 100);
    expect(radii[0]).toBe(8);
    expect(radii[radii.length - 1]).toBeLessThanOrEqual(100);
    expect(radii.length).toBeGreaterThan(10);
    for (let i = 1; i < radii.length; i++) expect(radii[i]).toBeGreaterThan(radii[i - 1]);
  });
});

describe("overlay mapping", () => {
  it("cover-crops a wide frame into a taller view", () => {
    // A 160×120 frame shown in a 120×120 square is scaled 1:1 and cropped
    // 20px from each side, so the frame's centre 80×60 band is centred.
    const frame = { width: 160, height: 120 };
    const view = { width: 120, height: 120 };
    const box = mapBoxThroughCover({ x: 40, y: 30, w: 80, h: 60 }, frame, view)!;
    expect(box.x).toBeCloseTo(20, 6);
    expect(box.y).toBeCloseTo(30, 6);
    expect(box.w).toBeCloseTo(80, 6);
    expect(box.h).toBeCloseTo(60, 6);
    // A box entirely in the cropped margin maps outside the viewport.
    const cropped = mapBoxThroughCover({ x: 0, y: 0, w: 10, h: 10 }, frame, view)!;
    expect(cropped.x + cropped.w).toBeLessThanOrEqual(0);
  });

  it("contain letterboxes and maps back through the same transform", () => {
    const frame = { width: 160, height: 120 };
    const view = { width: 160, height: 160 };
    const box = mapBoxThroughContain({ x: 40, y: 20, w: 40, h: 60 }, frame, view)!;
    expect(box.w).toBeCloseTo(40, 6);
    expect(box.y).toBeCloseTo(40, 6); // 20px top letterbox + 20px in
    const back = pointFromViewToFrame(box.x + box.w / 2, box.y + box.h / 2, frame, view, "contain");
    expect(back.x).toBeCloseTo(60, 6);
    expect(back.y).toBeCloseTo(50, 6);
  });

  it("medianOf handles odd, even and empty inputs", () => {
    expect(medianOf([3])).toBe(3);
    expect(medianOf([1, 9, 5])).toBe(5);
    expect(medianOf([1, 2, 3, 4])).toBe(2.5);
    expect(medianOf([])).toBe(0);
  });
});
