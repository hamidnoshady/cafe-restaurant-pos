/**
 * Unit tests for the visual-count API contract — pure payload validation, no
 * DB. The regexes and bounds here are the ones the routes trust, so the tests
 * pin each rule: data-URL shape and ceiling, region bounds, the two feature
 * payloads (and that a malformed one is refused, never repaired), the
 * evidence quantity's exact-decimal shape, and the method enum.
 */
import { describe, expect, it } from "vitest";
import {
  isImageDataUrl,
  parseBoxes,
  parseCountScanPayload,
  parseFeatures,
  parseRegion,
  parseVisualProfilePayload,
} from "./inventory-visual-profiles";

const JPEG = "data:image/jpeg;base64," + "A".repeat(1000);

const VALID_FEATURES_COLOR = {
  kind: "color",
  color: { signature: { mean: [50, 10, -5], spread: [2, 1, 1] }, tolerance: 12 },
  unitAreaRatio: 0.02,
};

const VALID_FEATURES_ROUND = { kind: "round", radiusRatio: 0.1, unitAreaRatio: 0.03 };

describe("isImageDataUrl", () => {
  it("accepts a capped base64 jpeg/png/webp data URL", () => {
    expect(isImageDataUrl(JPEG)).toBe(true);
    expect(isImageDataUrl("data:image/png;base64,AAAA")).toBe(true);
    expect(isImageDataUrl("data:image/webp;base64,AAAA")).toBe(true);
  });

  it("rejects other types, junk, and over-cap payloads", () => {
    expect(isImageDataUrl("data:image/svg+xml;base64,AAAA")).toBe(false);
    expect(isImageDataUrl("https://example.com/a.jpg")).toBe(false);
    expect(isImageDataUrl("")).toBe(false);
    expect(isImageDataUrl(42)).toBe(false);
    expect(isImageDataUrl("data:image/jpeg;base64," + "A".repeat(200_001))).toBe(false);
    expect(isImageDataUrl("data:image/jpeg;base64,not base64!!")).toBe(false);
  });
});

describe("parseRegion", () => {
  it("accepts a normalized box and clamps tiny float overflow", () => {
    expect(parseRegion({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(parseRegion({ x: 0.7, y: 0.2, w: 0.3, h: 0.4 })).not.toBeNull();
  });

  it("rejects out-of-range, empty and malformed boxes", () => {
    expect(parseRegion({ x: -0.1, y: 0, w: 0.5, h: 0.5 })).toBeNull();
    expect(parseRegion({ x: 0, y: 0, w: 0, h: 0.5 })).toBeNull();
    expect(parseRegion({ x: 0.5, y: 0, w: 0.6, h: 0.5 })).toBeNull();
    expect(parseRegion({ x: "a", y: 0, w: 0.5, h: 0.5 })).toBeNull();
    expect(parseRegion(null)).toBeNull();
  });
});

describe("parseFeatures", () => {
  it("accepts both engine payloads", () => {
    expect(parseFeatures(VALID_FEATURES_COLOR)).toEqual(VALID_FEATURES_COLOR);
    expect(parseFeatures(VALID_FEATURES_ROUND)).toEqual(VALID_FEATURES_ROUND);
  });

  it("refuses malformed payloads instead of repairing them", () => {
    expect(parseFeatures({ kind: "color" })).toBeNull();
    expect(parseFeatures({ kind: "color", color: { signature: { mean: [1, 2], spread: [0, 0, 0] }, tolerance: 10 } })).toBeNull();
    expect(parseFeatures({ kind: "color", color: { signature: { mean: [1, 2, 3], spread: [0, 0, 0] }, tolerance: 0 } })).toBeNull();
    expect(parseFeatures({ kind: "round", radiusRatio: 0 })).toBeNull();
    expect(parseFeatures({ kind: "round", radiusRatio: 2 })).toBeNull();
    expect(parseFeatures({ kind: "octagon" })).toBeNull();
    expect(parseFeatures(null)).toBeNull();
  });
});

describe("parseVisualProfilePayload", () => {
  const valid = {
    inventoryItemId: "item-1",
    source: "manual",
    kind: "color",
    imageDataUrl: JPEG,
    region: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    features: VALID_FEATURES_COLOR,
  };

  it("accepts a complete manual profile", () => {
    expect(parseVisualProfilePayload(valid)).toEqual(valid);
  });

  it("accepts an ai-sourced round profile", () => {
    expect(
      parseVisualProfilePayload({ ...valid, source: "ai", kind: "round", features: VALID_FEATURES_ROUND }),
    ).not.toBeNull();
  });

  it("rejects a missing item, a bad source, a bad image and a bad region", () => {
    expect(parseVisualProfilePayload({ ...valid, inventoryItemId: "" })).toBeNull();
    expect(parseVisualProfilePayload({ ...valid, source: "robot" })).toBeNull();
    expect(parseVisualProfilePayload({ ...valid, imageDataUrl: "nope" })).toBeNull();
    expect(parseVisualProfilePayload({ ...valid, region: { x: 5, y: 0, w: 1, h: 1 } })).toBeNull();
    expect(parseVisualProfilePayload(undefined)).toBeNull();
  });
});

describe("parseCountScanPayload", () => {
  const valid = {
    inventoryItemId: "item-1",
    method: "cv_color",
    countedQty: "12",
    confidence: 0.8,
    boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }],
    imageDataUrl: JPEG,
  };

  it("accepts a confirmed scan with exact-decimal quantity", () => {
    expect(parseCountScanPayload(valid)).toEqual(valid);
    expect(parseCountScanPayload({ ...valid, countedQty: "12.500", method: "ai_vision" })).not.toBeNull();
    expect(parseCountScanPayload({ ...valid, method: "cv_round", boxes: [] })).not.toBeNull();
  });

  it("rejects bad methods, quantities and confidences", () => {
    expect(parseCountScanPayload({ ...valid, method: "cv_magic" })).toBeNull();
    expect(parseCountScanPayload({ ...valid, countedQty: "12.5000" })).toBeNull();
    expect(parseCountScanPayload({ ...valid, countedQty: "-1" })).toBeNull();
    expect(parseCountScanPayload({ ...valid, countedQty: "abc" })).toBeNull();
    expect(parseCountScanPayload({ ...valid, confidence: 1.5 })).toBeNull();
    expect(parseCountScanPayload({ ...valid, confidence: "high" })).toBeNull();
    expect(parseCountScanPayload({ ...valid, boxes: [{ x: 9, y: 0, w: 1, h: 1 }] })).toBeNull();
  });
});

describe("parseBoxes", () => {
  it("caps the array at 400 entries", () => {
    const many = Array.from({ length: 401 }, () => ({ x: 0, y: 0, w: 0.01, h: 0.01 }));
    expect(parseBoxes(many)).toBeNull();
    expect(parseBoxes(many.slice(0, 400))).toHaveLength(400);
  });
});
