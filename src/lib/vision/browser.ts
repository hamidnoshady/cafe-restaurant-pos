"use client";

/**
 * The browser half of the visual stock counter — the only file in
 * `src/lib/vision/` that touches the DOM. It turns sources (a camera frame, a
 * picked photo, a video element, a data URL) into the pure `VisionImage`
 * buffers the counting engine eats, and packs results back into data URLs for
 * storage. Everything algorithmic lives in the pure modules; this file is
 * I/O only, which is also why it has no unit tests — the algorithms it feeds
 * are the tested part.
 *
 * Resolution policy: every source is downscaled so its longest edge is at
 * most `ANALYSIS_MAX_DIM` (640px) before analysis. The classical engine's
 * cost scales with pixels, and a 640px photo already resolves a unit that
 * fills 5% of the frame to ~30px — comfortably above the noise floor. The
 * JPEG that is *stored* (a profile's reference photo, a count scan's
 * evidence) is re-encoded smaller still, so a shelf photo never costs the
 * database more than a receipt logo does.
 */

import type { VisionImage } from "./image";

/** Longest-edge cap for images fed to the counting engine. */
export const ANALYSIS_MAX_DIM = 640;
/** Longest-edge cap for a stored visual-profile reference photo. */
export const PROFILE_IMAGE_MAX_DIM = 480;
/** Longest-edge cap for a stored count-scan evidence photo. */
export const EVIDENCE_IMAGE_MAX_DIM = 320;
/** Quality for stored JPEGs (analysis buffers are never encoded). */
const STORED_JPEG_QUALITY = 0.72;

function scaledSize(width: number, height: number, maxDim: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDim || longest === 0) return { width: Math.max(1, width), height: Math.max(1, height) };
  const scale = maxDim / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function contextFor(width: number, height: number): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext("2d", { willReadFrequently: true });
}

/** Draws any drawable source into a VisionImage at most `maxDim` on its longest edge. */
function drawToVisionImage(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  maxDim: number,
): VisionImage | null {
  const { width, height } = scaledSize(sourceWidth, sourceHeight, maxDim);
  const ctx = contextFor(width, height);
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { width, height, data: imageData.data };
}

/** The current frame of a live <video>, at analysis resolution. */
export function frameFromVideoElement(video: HTMLVideoElement, maxDim = ANALYSIS_MAX_DIM): VisionImage | null {
  if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return null;
  return drawToVisionImage(video, video.videoWidth, video.videoHeight, maxDim);
}

/** A picked photo File, decoded and downscaled. */
export async function imageFromFile(file: File, maxDim = ANALYSIS_MAX_DIM): Promise<VisionImage | null> {
  const url = URL.createObjectURL(file);
  try {
    return await imageFromObjectUrl(url, maxDim);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageFromObjectUrl(url: string, maxDim: number): Promise<VisionImage | null> {
  const img = new Image();
  img.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("image decode failed"));
  });
  img.src = url;
  await loaded;
  return drawToVisionImage(img, img.naturalWidth, img.naturalHeight, maxDim);
}

/** A stored data URL back into an analysis buffer (the tagged reference photo). */
export async function imageFromDataUrl(dataUrl: string, maxDim = ANALYSIS_MAX_DIM): Promise<VisionImage | null> {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
  return imageFromObjectUrl(dataUrl, maxDim);
}

/**
 * Encodes a VisionImage as a JPEG data URL, shrinking it (and stepping the
 * quality down) until it fits under `maxChars` — the storage cap the API
 * enforces on the other end. Returns null if even a 240px q0.5 JPEG doesn't
 * fit (practically impossible; the guard is for a corrupt buffer).
 */
export function toStoredJpegDataUrl(image: VisionImage, maxDim: number, maxChars: number): string | null {
  const attempts: Array<{ dim: number; quality: number }> = [
    { dim: maxDim, quality: STORED_JPEG_QUALITY },
    { dim: Math.min(maxDim, 400), quality: 0.6 },
    { dim: 320, quality: 0.55 },
    { dim: 240, quality: 0.5 },
  ];
  for (const { dim, quality } of attempts) {
    const { width, height } = scaledSize(image.width, image.height, dim);
    const ctx = contextFor(width, height);
    if (!ctx) return null;
    // VisionImage → ImageData shares the same RGBA layout.
    ctx.putImageData(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), 0, 0);
    if (width !== image.width || height !== image.height) {
      const target = contextFor(width, height);
      if (!target) return null;
      target.drawImage(ctx.canvas, 0, 0, width, height);
      const url = target.canvas.toDataURL("image/jpeg", quality);
      if (url.length <= maxChars) return url;
      continue;
    }
    const url = ctx.canvas.toDataURL("image/jpeg", quality);
    if (url.length <= maxChars) return url;
  }
  return null;
}

/**
 * Loads a video File's dimensions and duration by attaching it to an off-DOM
 * <video> — the caller then owns seeking/playing that element for sampling.
 */
export function videoElementFromFile(file: File): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const url = URL.createObjectURL(file);
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("video decode failed"));
    };
    // Keep the URL alive for the element's lifetime; the caller stops it via
    // unloadVideoElement.
    (video as HTMLVideoElement & { __objectUrl?: string }).__objectUrl = url;
    video.src = url;
  });
}

/** Stops a sampled video element and releases its blob URL. */
export function unloadVideoElement(video: HTMLVideoElement | null): void {
  if (!video) return;
  const url = (video as HTMLVideoElement & { __objectUrl?: string }).__objectUrl;
  try {
    video.pause();
  } catch {
    // Already stopped.
  }
  video.removeAttribute("src");
  try {
    video.load();
  } catch {
    // Detached element — nothing left to release.
  }
  if (url) URL.revokeObjectURL(url);
}
