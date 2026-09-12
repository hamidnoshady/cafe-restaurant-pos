/**
 * Unit tests for the AI vision-count reply parser. The parser is the boundary
 * between a language model and a number that gets stored next to a stock
 * count, so every test pins one way a model answer must not become a wrong
 * count: fenced JSON is tolerated, out-of-range values are clamped (never
 * dropped, never passed through), a null count means "couldn't count", and
 * prose/garbage is a clean null.
 */
import { describe, expect, it } from "vitest";
import { parseVisionCountReply, visionCountUserPrompt } from "./ai-inventory-vision";

describe("parseVisionCountReply", () => {
  it("parses a clean JSON reply", () => {
    const reply = parseVisionCountReply(
      '{"count": 12, "confidence": 0.8, "box": {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2}, "comment": "دو ردیف شش‌تایی"}',
    );
    expect(reply).toEqual({
      count: 12,
      confidence: 0.8,
      box: { x: 0.1, y: 0.2, w: 0.3, h: 0.2 },
      comment: "دو ردیف شش‌تایی",
    });
  });

  it("tolerates a ```json fence around the object", () => {
    const reply = parseVisionCountReply('```json\n{"count": 3, "confidence": 0.9, "box": null, "comment": ""}\n```');
    expect(reply).not.toBeNull();
    expect(reply!.count).toBe(3);
    expect(reply!.box).toBeNull();
  });

  it("clamps counts, confidences and boxes into range", () => {
    const reply = parseVisionCountReply(
      '{"count": -5, "confidence": 1.7, "box": {"x": -0.2, "y": 0, "w": 2, "h": 0.5}, "comment": "x"}',
    );
    expect(reply!.count).toBe(0);
    expect(reply!.confidence).toBe(1);
    expect(reply!.box).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
  });

  it("defaults a missing confidence to 0.5 and trims long comments", () => {
    const reply = parseVisionCountReply(
      `{"count": 7, "comment": "${"یادداشت".repeat(60)}"}`,
    );
    expect(reply!.confidence).toBe(0.5);
    expect(reply!.comment.length).toBeLessThanOrEqual(200);
  });

  it("returns null when the model says it cannot count", () => {
    expect(parseVisionCountReply('{"count": null, "comment": "تصویر تار است"}')).toBeNull();
  });

  it("returns null for prose, garbage and empty replies", () => {
    expect(parseVisionCountReply("متأسفانه نمی‌توانم بشمارم.")).toBeNull();
    expect(parseVisionCountReply("")).toBeNull();
    expect(parseVisionCountReply("{\"count\": \"بیست\"}")).toBeNull();
    expect(parseVisionCountReply("[1, 2, 3]")).toBeNull();
  });

  it("drops a malformed box but keeps the count", () => {
    const reply = parseVisionCountReply('{"count": 4, "confidence": 0.6, "box": {"x": "چپ"}, "comment": ""}');
    expect(reply!.count).toBe(4);
    expect(reply!.box).toBeNull();
  });
});

describe("visionCountUserPrompt", () => {
  it("names the item and its unit", () => {
    const prompt = visionCountUserPrompt("لیوان کاغذی ۳۶۰", "عدد");
    expect(prompt).toContain("لیوان کاغذی ۳۶۰");
    expect(prompt).toContain("عدد");
    expect(prompt).toContain("JSON");
  });
});
