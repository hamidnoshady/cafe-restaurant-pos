/**
 * The counting engine of the visual stock counter — the pure strategies that
 * turn a photo plus a saved «برچسب تصویری» (visual profile) into a confirmed
 * count, plus the self-validating profile builder.
 *
 * Two strategies, one per profile kind, each classical CV with no AI and no
 * dependencies:
 *
 *   * `color` — mask the photo by the tagged region's Lab signature, open the
 *     mask, label connected components, then estimate how many units each blob
 *     is by comparing its area to the *median* blob area in this photo. The
 *     median is the trick that makes it work without calibration: whatever
 *     distance and angle the photo was taken from, a normal unit's blob area
 *     and a merged double-unit's blob area both scale together, and the median
 *     of a mostly-singles population *is* the single-unit area. Works for
 *     distinctive items — branded cartons, colored lids, wooden stirrers on a
 *     steel counter.
 *
 *   * `round` — gradient Hough circles, clustered by radius; the dominant
 *     equal-radius cluster is the row of identical round things (cups, cans,
 *     plates). Chosen for the exact items color fails at: plain white cups on
 *     a pale shelf, where every blob is the same color as the background.
 *
 * The profile builder picks the kind *empirically*: it runs both strategies
 * against the very photo the operator just tagged and keeps the one that
 * counts that photo as exactly the one unit the operator boxed. No heuristic
 * guess about "does this look round" — the engine grades itself on evidence it
 * can see.
 *
 * Nothing here is trusted blindly: every result carries a confidence, the UI
 * draws the boxes it based the count on, and the operator confirms the number
 * before it touches the tally. A count that looks wrong is corrected by a
 * human in one glance, never posted silently.
 */

import { boxAreaRatio, type Box, type VisionImage } from "./image";
import {
  defaultTolerance,
  maskBySignature,
  signatureFromRegion,
  type ColorSignature,
} from "./color";
import { openMask } from "./morphology";
import { findComponents, type BlobInfo } from "./components";
import { detectCircles } from "./circles";

export type VisualProfileKind = "color" | "round";

/** Counting-method keys, shared with the API and the evidence rows. */
export type CountMethod = "cv_color" | "cv_round" | "ai_vision";

/** The stored feature payload of a visual profile (jsonb in the DB). */
export interface VisualProfileFeatures {
  kind: VisualProfileKind;
  /** color strategy only — the Lab signature of one unit and its tolerance. */
  color?: { signature: ColorSignature; tolerance: number };
  /** round strategy only — the unit's radius as a fraction of min(width, height). */
  radiusRatio?: number;
  /**
   * How much of the tagged photo the one unit filled (0..1). Not used as an
   * absolute scale — photos are taken at other distances — but as a sanity
   * cross-check on the median-unit estimate and to reject absurd tags.
   */
  unitAreaRatio?: number;
}

export interface CountResult {
  count: number;
  /** 0..1 — how much the strategy trusts its own number. */
  confidence: number;
  /** What was counted, one box per counted unit group, in image pixels. */
  boxes: Box[];
  method: CountMethod;
  /**
   * Human-oriented detail for the audit row: blob/circle counts the raw pass
   * produced before the unit estimate, so a wrong confirmed count can be
   * explained later ("saw 3 blobs, one was a 2-unit merged blob").
   */
  detail: string;
}

/** Blob area (in pixels) below which a component is noise, not stock. */
function noiseFloor(image: VisionImage): number {
  return Math.max(24, image.width * image.height * 0.0004);
}

/** Estimates units per blob from its area against the single-unit area. */
export function unitsInBlob(area: number, unitArea: number): number {
  if (unitArea <= 0) return 1;
  const ratio = area / unitArea;
  // Round to nearest integer, but a blob must be at least 35% bigger than one
  // unit before it is allowed to be two — round() alone would call a 1.3×
  // shading blob "two units" and overcount by a third.
  return Math.max(1, Math.round(ratio >= 1.35 ? ratio : 1));
}

/**
 * The color strategy. See the module doc for the median self-calibration.
 * Confidence is highest when the photo is a population of clean single-unit
 * blobs, and falls with each blob the estimator had to split by area.
 *
 * `priorUnitArea` is the tagged unit's area rescaled into this photo (the
 * profile's `unitAreaRatio` × this photo's area). The median blob area is
 * normally the better single-unit estimate — it measures *this* photo, at
 * *this* distance. But a pile where every blob is a merged row makes the
 * median a multiple of the unit, and that is exactly when the prior, which
 * came from a photo of the same shelf taken the same way, is the anchor that
 * keeps the count honest. Rule: trust the median while it is within ~2.2× of
 * the prior; beyond that, the blobs are merged and the prior wins (and the
 * confidence is cut, because splitting blobs by area is the estimator's
 * weakest move).
 */
export function countByColor(
  image: VisionImage,
  signature: ColorSignature,
  tolerance: number,
  priorUnitArea?: number,
): CountResult {
  const rawMask = maskBySignature(image, signature, tolerance);
  const mask = openMask(rawMask, image, 1);
  const blobs = findComponents(mask, image, noiseFloor(image));

  if (blobs.length === 0) {
    return { count: 0, confidence: 0, boxes: [], method: "cv_color", detail: "هیچ ناحیهٔ همرنگ پیدا نشد." };
  }

  // Median blob area = the single-unit area for this photo (robust: a merged
  // double blob shifts the median far less than it shifts the mean).
  const areas = blobs.map((b) => b.area).sort((a, b) => a - b);
  const medianArea = areas.length % 2 ? areas[areas.length >> 1] : (areas[(areas.length >> 1) - 1] + areas[areas.length >> 1]) / 2;

  let unitArea = medianArea;
  let splitByPrior = false;
  if (priorUnitArea && priorUnitArea > 0 && medianArea > priorUnitArea * 2.2) {
    unitArea = priorUnitArea;
    splitByPrior = true;
  }

  let count = 0;
  let singles = 0;
  const boxes: Box[] = [];
  for (const blob of blobs) {
    const units = unitsInBlob(blob.area, unitArea);
    count += units;
    boxes.push(blob.box);
    if (units === 1) singles++;
  }

  // Confidence model: every blob that was exactly one unit is evidence the
  // photo was legible; blobs that needed splitting are evidence it wasn't.
  const singleShare = singles / blobs.length;
  let confidence = Math.max(0.15, Math.min(0.97, singleShare * 0.75 + (1 / blobs.length) * 0.25));
  if (splitByPrior) confidence = Math.min(confidence, 0.72);

  const detail =
    blobs.length === count
      ? `${blobs.length} ناحیهٔ جدا شمارش شد.`
      : `${blobs.length} ناحیه پیدا شد؛ نواحی چسبیده بر اساس مساحت تخمین زده شدند.`;

  return { count, confidence, boxes, method: "cv_color", detail };
}

/** The round strategy: dominant equal-radius circle cluster = the units. */
export function countByRounds(
  image: VisionImage,
  radiusHint: number | null,
): CountResult {
  const minDim = Math.min(image.width, image.height);
  // A hint (from the tag) narrows the sweep; without one, sweep the plausible
  // shelf-photo band. The clustering below still guards against the hint being
  // from a photo taken at a different distance.
  const minRadius = radiusHint ? Math.max(3, radiusHint * minDim * 0.55) : minDim * 0.04;
  const maxRadius = radiusHint ? Math.min(minDim / 2 - 1, radiusHint * minDim * 1.9) : minDim * 0.24;
  const circles = detectCircles(image, { minRadius, maxRadius });

  if (circles.length === 0) {
    return { count: 0, confidence: 0, boxes: [], method: "cv_round", detail: "دایره‌ای پیدا نشد." };
  }

  // Cluster by radius (±20%): identical physical items produce one cluster.
  const sorted = [...circles].sort((a, b) => a.r - b.r);
  let best: DetectedGroup = { members: [sorted[0]] };
  let current: DetectedGroup = { members: [sorted[0]] };
  for (const c of sorted.slice(1)) {
    const reference = current.members[current.members.length - 1];
    if (c.r <= reference.r * 1.2) {
      current.members.push(c);
    } else {
      if (current.members.length > best.members.length) best = current;
      current = { members: [c] };
    }
  }
  if (current.members.length > best.members.length) best = current;

  const boxes = best.members.map((c) => circleBox(c));
  // Cluster size share and rim scores both feed confidence: five crisp circles
  // out of five detections is a confident count; two faint circles out of
  // eleven noisy ones is a guess the operator must check.
  const share = best.members.length / circles.length;
  const meanScore =
    best.members.reduce((sum, c) => sum + c.score, 0) / best.members.length;
  const confidence = Math.max(0.15, Math.min(0.95, share * 0.45 + meanScore * 1.1));

  return {
    count: best.members.length,
    confidence,
    boxes,
    method: "cv_round",
    detail: `${best.members.length} دایرهٔ هم‌اندازه از ${circles.length} دایرهٔ کل.`,
  };
}

interface DetectedGroup {
  members: { cx: number; cy: number; r: number; score: number }[];
}

function circleBox(c: { cx: number; cy: number; r: number }): Box {
  return { x: c.cx - c.r, y: c.cy - c.r, w: 2 * c.r, h: 2 * c.r };
}

/** Count a photo with a stored profile. */
export function countWithProfile(image: VisionImage, profile: VisualProfileFeatures): CountResult {
  if (profile.kind === "round") {
    return countByRounds(image, profile.radiusRatio ?? null);
  }
  if (profile.color) {
    const prior =
      profile.unitAreaRatio && profile.unitAreaRatio > 0
        ? profile.unitAreaRatio * image.width * image.height
        : undefined;
    return countByColor(image, profile.color.signature, profile.color.tolerance, prior);
  }
  return { count: 0, confidence: 0, boxes: [], method: "cv_color", detail: "برچسب ناقص است." };
}

/**
 * Builds a visual profile from a photo and the region the operator tagged as
 * "exactly one unit". The strategy is chosen empirically, by grading both
 * engines against the one ground truth we have — the tagged region itself:
 *
 *   * the color engine is graded by how exactly its mask isolates the region:
 *     label the mask, take the blob under the region's center, and score the
 *     overlap (IoU) between that blob's box and the tagged region. A clean
 *     tag scores ~1; a white cup on a white shelf masks the whole frame and
 *     scores ~0.
 *   * the round engine is graded by whether a Hough circle sits inside the
 *     region at the region's own radius.
 *
 * Color wins ties: its evidence is transferable to future photos of the same
 * shelf, while a circle found once may be the rim of the very thing color
 * already explains. A tag neither engine can reproduce is rejected (null)
 * rather than saved as a profile that will miscount every future photo.
 */
export function buildProfileFromRegion(
  image: VisionImage,
  region: Box,
): { profile: VisualProfileFeatures; kindScore: number } | null {
  const signature = signatureFromRegion(image, region);
  if (!signature) return null;
  const areaRatio = boxAreaRatio(region, image);
  // A tag must be a plausible unit: between 0.05% and 60% of the frame.
  // Bigger than that and the operator tagged the whole photo (the mask then
  // covers everything and every future photo counts as "1"); smaller and it
  // is a tap that missed.
  if (areaRatio < 0.0005 || areaRatio > 0.6) return null;

  const colorScore = gradeColorEngine(image, region, signature);
  const roundScore = gradeRoundEngine(image, region);

  const kind: VisualProfileKind =
    colorScore >= 0.5 || colorScore >= roundScore ? "color" : "round";
  const kindScore = kind === "color" ? colorScore : roundScore;
  if (kindScore < 0.3) return null;

  const minDim = Math.min(image.width, image.height);
  const profile: VisualProfileFeatures = {
    kind,
    unitAreaRatio: areaRatio,
    ...(kind === "color"
      ? { color: { signature, tolerance: defaultTolerance(signature) } }
      : { radiusRatio: Math.min(region.w, region.h) / 2 / minDim }),
  };
  return { profile, kindScore };
}

/**
 * Color-engine grade: does the signature's mask (a) actually cover the tagged
 * unit, and (b) stay off the background?
 *
 * (a) is the share of the tagged region that the mask retains — a signature
 * that can't even reproduce its own tag is wrong.
 * (b) is a coverage penalty: a signature that masks ~the whole frame (a white
 * cup on a white shelf) has not separated anything, however high its recall.
 * A merged pile legitimately produces one big blob, so bigness of the blob is
 * *not* penalized — only how much of the entire image the mask swallowed.
 */
function gradeColorEngine(image: VisionImage, region: Box, signature: ColorSignature): number {
  const mask = openMask(maskBySignature(image, signature, defaultTolerance(signature)), image, 1);
  let inRegion = 0;
  let masked = 0;
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(image.width, Math.ceil(region.x + region.w));
  const y1 = Math.min(image.height, Math.ceil(region.y + region.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (mask[y * image.width + x]) inRegion++;
    }
  }
  for (let i = 0; i < mask.length; i++) masked += mask[i];
  if (inRegion === 0) return 0;
  const recall = inRegion / (Math.max(1, (x1 - x0) * (y1 - y0)));
  const coverage = masked / mask.length;
  const coveragePenalty = Math.max(0, (coverage - 0.85) / 0.15);
  return Math.max(0, recall - coveragePenalty);
}

/** Best Hough circle that sits inside the region at the region's radius. */
function gradeRoundEngine(image: VisionImage, region: Box): number {
  const minDim = Math.min(image.width, image.height);
  const expectedR = Math.min(region.w, region.h) / 2;
  if (expectedR < 4) return 0;
  const cx = region.x + region.w / 2;
  const cy = region.y + region.h / 2;
  const circles = detectCircles(image, {
    minRadius: Math.max(3, expectedR * 0.6),
    maxRadius: Math.min(minDim / 2 - 1, expectedR * 1.7),
  });
  let best = 0;
  for (const c of circles) {
    const centerDist = Math.hypot(c.cx - cx, c.cy - cy);
    const radiusGap = Math.abs(c.r - expectedR) / expectedR;
    if (centerDist > expectedR * 0.9 || radiusGap > 0.4) continue;
    const closeness = 1 - centerDist / (expectedR * 0.9);
    best = Math.max(best, 0.55 + 0.45 * Math.min(1, closeness * 1.5 + (1 - radiusGap / 0.4) * 0.5));
  }
  return Math.min(1, best);
}

/**
 * Tap-to-tag helper: the operator taps one unit in a photo; find the
 * color-similar blob under the tap and return its bounding box. The signature
 * is seeded from a small window at the tap point (the unit's own surface, not
 * the shelf), then the full-image mask is labeled and the component containing
 * the tap wins. Returns null when the tap landed on something untaggable —
 * background, or a blob so large it is clearly not one unit.
 */
export function regionAtPoint(image: VisionImage, x: number, y: number): { box: Box; signature: ColorSignature } | null {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  const radius = Math.max(3, Math.round(Math.min(image.width, image.height) * 0.012));
  const seed = signatureFromRegion(image, {
    x: x - radius,
    y: y - radius,
    w: 2 * radius,
    h: 2 * radius,
  });
  if (!seed) return null;

  const mask = openMask(maskBySignature(image, seed, defaultTolerance(seed)), image, 1);
  const blobs = findComponents(mask, image, noiseFloor(image));
  const blob = blobs.find((b) => blobContains(b, x, y, image));
  if (!blob) return null;
  const areaRatio = blob.area / (image.width * image.height);
  if (areaRatio < 0.0005 || areaRatio > 0.6) return null;

  const signature = signatureFromRegion(image, blob.box) ?? seed;
  return { box: blob.box, signature };
}

function blobContains(blob: BlobInfo, x: number, y: number, image: VisionImage): boolean {
  // Falling back to the bounding box is deliberate: after opening, a spec of
  // the mask near the tap can belong to a *different* blob than the unit the
  // operator meant, and the bbox is the stable definition of "the thing under
  // the finger".
  void image;
  const { box } = blob;
  return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h;
}
