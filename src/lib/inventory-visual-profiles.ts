/**
 * Pure contract for the visual stock count's two API resources — the
 * «برچسب تصویری» (visual profiles) and the count-scan evidence rows. The
 * routes validate with these, the client types against them, and the unit
 * tests exercise them without a DB: the same shape `parties.ts` gives the
 * party endpoints.
 *
 * The image payloads are inline JPEG data URLs, capped hard. The cap matches
 * the migration's CHECK with headroom: 200,000 base64 characters ≈ a 150 KB
 * image, and the client downscales to 480px (profiles) / 320px (evidence)
 * before uploading, so the ceiling is a guard against a buggy client, not a
 * size the healthy path ever approaches — the same reasoning as the
 * business-logo cap in `business-logo.ts`.
 */

import type { NormalizedBox } from "./vision/image";
import type { VisualProfileFeatures } from "./vision/count";

export type VisualProfileSource = "manual" | "ai";
export type CountScanMethod = "cv_color" | "cv_round" | "ai_vision";

export const VISUAL_PROFILE_KINDS = ["color", "round"] as const;
export const VISUAL_PROFILE_SOURCES = ["manual", "ai"] as const;
export const COUNT_SCAN_METHODS = ["cv_color", "cv_round", "ai_vision"] as const;

/** Hard ceiling for a stored data URL (base64 chars); the DB CHECK is 220000. */
export const MAX_IMAGE_DATA_URL_CHARS = 200_000;
/** Product cap on reference shots per item — the API answers with a Persian error. */
export const MAX_PROFILES_PER_ITEM = 8;

const DATA_URL_RE = /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** A stored visual profile as the API returns it. (A type alias, not an
 *  interface, so `query<T>`'s `Record<string, unknown>` constraint accepts it.) */
export type VisualProfileRecord = {
  id: string;
  inventoryItemId: string;
  source: VisualProfileSource;
  kind: "color" | "round";
  imageDataUrl: string;
  region: NormalizedBox;
  features: VisualProfileFeatures;
  createdAt: string;
};

/** A stored count-scan evidence row as the API returns it. */
export type CountScanRecord = {
  id: string;
  inventoryItemId: string;
  itemName: string;
  unit: string;
  method: CountScanMethod;
  countedQty: string;
  confidence: string;
  boxes: NormalizedBox[];
  imageDataUrl: string;
  createdAt: string;
  createdByName: string | null;
};

export function isImageDataUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_IMAGE_DATA_URL_CHARS) return false;
  return DATA_URL_RE.test(value);
}

/** A region is valid when it is a 0..1 box with a non-empty footprint. */
export function parseRegion(value: unknown): NormalizedBox | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const x = Number(v.x);
  const y = Number(v.y);
  const w = Number(v.w);
  const h = Number(v.h);
  if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return null;
  if (x + w > 1.001 || y + h > 1.001) return null;
  return { x, y, w, h };
}

/**
 * Visual-profile features: `kind` plus the payload the matching engine needs.
 * Accepts exactly what `buildProfileFromRegion` emits — the shape is a
 * contract with src/lib/vision/count.ts, so anything malformed is refused
 * rather than repaired: a "fixed" feature vector silently miscounts.
 */
export function parseFeatures(value: unknown): VisualProfileFeatures | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const kind = v.kind;
  if (kind !== "color" && kind !== "round") return null;

  if (kind === "color") {
    const color = v.color;
    if (!color || typeof color !== "object") return null;
    const c = color as Record<string, unknown>;
    const signature = c.signature;
    if (!signature || typeof signature !== "object") return null;
    const s = signature as Record<string, unknown>;
    const mean = s.mean;
    const spread = s.spread;
    const tolerance = Number(c.tolerance);
    if (!Array.isArray(mean) || !Array.isArray(spread) || mean.length !== 3 || spread.length !== 3) return null;
    const meanNums = mean.map(Number);
    const spreadNums = spread.map(Number);
    if (![...meanNums, ...spreadNums].every((n) => Number.isFinite(n))) return null;
    if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 120) return null;
    return {
      kind,
      color: { signature: { mean: meanNums as [number, number, number], spread: spreadNums as [number, number, number] }, tolerance },
      ...(typeof v.unitAreaRatio === "number" && Number.isFinite(v.unitAreaRatio) && v.unitAreaRatio > 0
        ? { unitAreaRatio: v.unitAreaRatio }
        : {}),
    };
  }

  const radiusRatio = Number(v.radiusRatio);
  if (!Number.isFinite(radiusRatio) || radiusRatio <= 0 || radiusRatio > 0.5) return null;
  return {
    kind: "round",
    radiusRatio,
    ...(typeof v.unitAreaRatio === "number" && Number.isFinite(v.unitAreaRatio) && v.unitAreaRatio > 0
      ? { unitAreaRatio: v.unitAreaRatio }
      : {}),
  };
}

export interface VisualProfilePayload {
  inventoryItemId: string;
  source: VisualProfileSource;
  kind: "color" | "round";
  imageDataUrl: string;
  region: NormalizedBox;
  features: VisualProfileFeatures;
}

/** Validates a POST /api/inventory/visual-profiles body. */
export function parseVisualProfilePayload(body: unknown): VisualProfilePayload | null {
  if (!body || typeof body !== "object") return null;
  const v = body as Record<string, unknown>;
  if (typeof v.inventoryItemId !== "string" || v.inventoryItemId.length === 0) return null;
  if (!VISUAL_PROFILE_SOURCES.includes(v.source as VisualProfileSource)) return null;
  if (!VISUAL_PROFILE_KINDS.includes(v.kind as (typeof VISUAL_PROFILE_KINDS)[number])) return null;
  if (!isImageDataUrl(v.imageDataUrl)) return null;
  const region = parseRegion(v.region);
  if (!region) return null;
  const features = parseFeatures(v.features);
  if (!features) return null;
  return {
    inventoryItemId: v.inventoryItemId,
    source: v.source as VisualProfileSource,
    kind: v.kind as "color" | "round",
    imageDataUrl: v.imageDataUrl,
    region,
    features,
  };
}

/** Boxes for an evidence row: an array of at most 400 normalized boxes. */
export function parseBoxes(value: unknown): NormalizedBox[] | null {
  if (!Array.isArray(value) || value.length > 400) return null;
  const boxes: NormalizedBox[] = [];
  for (const item of value) {
    const box = parseRegion(item);
    if (!box) return null;
    boxes.push(box);
  }
  return boxes;
}

export interface CountScanPayload {
  inventoryItemId: string;
  method: CountScanMethod;
  /** Confirmed quantity, kept as a string to preserve Decimal exactness. */
  countedQty: string;
  confidence: number;
  boxes: NormalizedBox[];
  imageDataUrl: string;
}

/** Validates a POST /api/inventory/visual-count-scans body. */
export function parseCountScanPayload(body: unknown): CountScanPayload | null {
  if (!body || typeof body !== "object") return null;
  const v = body as Record<string, unknown>;
  if (typeof v.inventoryItemId !== "string" || v.inventoryItemId.length === 0) return null;
  if (!COUNT_SCAN_METHODS.includes(v.method as CountScanMethod)) return null;
  if (!isImageDataUrl(v.imageDataUrl)) return null;

  const countedQty = typeof v.countedQty === "string" ? v.countedQty.trim() : "";
  if (!/^\d+(\.\d{1,3})?$/.test(countedQty)) return null;

  const confidence = Number(v.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const boxes = parseBoxes(v.boxes);
  if (!boxes) return null;

  return {
    inventoryItemId: v.inventoryItemId,
    method: v.method as CountScanMethod,
    countedQty,
    confidence,
    boxes,
    imageDataUrl: v.imageDataUrl,
  };
}
