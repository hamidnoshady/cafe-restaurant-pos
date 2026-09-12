/**
 * Mapping counted boxes onto the on-screen preview — pure math, because it is
 * exactly the kind of small geometry that silently drifts when written inline
 * in a component twice.
 *
 * The camera/video preview is rendered with `object-cover` (fill the box, crop
 * the overflow) and the still-photo preview with `object-contain` (fit inside,
 * letterbox). Counting runs on the full frame at analysis resolution; the
 * operator sees the cropped/letterboxed view. These two functions convert a
 * box in frame pixels to its on-screen rectangle under each fit mode, so the
 * overlay canvas draws the boxes exactly over the units that were counted.
 */

import type { Box } from "./image";

export interface Viewport {
  width: number;
  height: number;
}

interface CoverTransform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

function coverTransform(frame: Viewport, view: Viewport): CoverTransform {
  const scale = Math.max(view.width / frame.width, view.height / frame.height);
  return {
    scale,
    offsetX: (view.width - frame.width * scale) / 2,
    offsetY: (view.height - frame.height * scale) / 2,
  };
}

function containTransform(frame: Viewport, view: Viewport): CoverTransform {
  const scale = Math.min(view.width / frame.width, view.height / frame.height);
  return {
    scale,
    offsetX: (view.width - frame.width * scale) / 2,
    offsetY: (view.height - frame.height * scale) / 2,
  };
}

function mapBox(box: Box, t: CoverTransform): Box | null {
  const x = box.x * t.scale + t.offsetX;
  const y = box.y * t.scale + t.offsetY;
  const w = box.w * t.scale;
  const h = box.h * t.scale;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

/** A frame box in preview coordinates under `object-cover`. */
export function mapBoxThroughCover(box: Box, frame: Viewport, view: Viewport): Box | null {
  return mapBox(box, coverTransform(frame, view));
}

/** A frame box in preview coordinates under `object-contain`. */
export function mapBoxThroughContain(box: Box, frame: Viewport, view: Viewport): Box | null {
  return mapBox(box, containTransform(frame, view));
}

/**
 * A tap on the preview, in preview coordinates, back to frame pixels — the
 * inverse of the same transforms, for tap-to-tag.
 */
export function pointFromViewToFrame(
  x: number,
  y: number,
  frame: Viewport,
  view: Viewport,
  fit: "cover" | "contain",
): { x: number; y: number } {
  const t = fit === "cover" ? coverTransform(frame, view) : containTransform(frame, view);
  return { x: (x - t.offsetX) / t.scale, y: (y - t.offsetY) / t.scale };
}

/** Median of a list (sorted middle; even lengths average the middle pair). */
export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
