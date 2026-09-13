import { describe, expect, it } from "vitest";
import {
  imageEditsUrl,
  MEDIA_ENHANCE_PROMPT,
  MEDIA_LABEL_SYSTEM_PROMPT,
  mediaLabelUserPrompt,
  parseImageEditReply,
  parseMediaLabelReply,
} from "./ai-media";

describe("media label prompts", () => {
  it("asks for raw JSON with category, tags and description", () => {
    expect(MEDIA_LABEL_SYSTEM_PROMPT).toContain('"category"');
    expect(MEDIA_LABEL_SYSTEM_PROMPT).toContain('"tags"');
    expect(MEDIA_LABEL_SYSTEM_PROMPT).toContain('"description"');
  });
  it("carries the file name into the user prompt", () => {
    expect(mediaLabelUserPrompt("منو.jpg")).toContain("منو.jpg");
  });
});

describe("parseMediaLabelReply", () => {
  it("parses a plain reply and a fenced one", () => {
    const plain = parseMediaLabelReply('{"category":"غذا و نوشیدنی","tags":["قهوه","لاته"],"description":"یک فنجان قهوه"}');
    expect(plain).toEqual({ category: "غذا و نوشیدنی", tags: ["قهوه", "لاته"], description: "یک فنجان قهوه" });
    const fenced = parseMediaLabelReply('```json\n{"category":"محصول","tags":["کفش"],"description":""}\n```');
    expect(fenced?.category).toBe("محصول");
  });

  it("clamps: dedupes tags, caps at 8, trims oversize strings", () => {
    const reply = parseMediaLabelReply(
      JSON.stringify({
        category: "c".repeat(200),
        tags: ["a", "a", "b", "", 5, "c", "d", "e", "f", "g", "h", "i", "j"],
        description: "d".repeat(500),
      }),
    );
    expect(reply?.category).toHaveLength(80);
    expect(reply?.tags).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(reply?.description).toHaveLength(200);
  });

  it("returns null for garbage or an empty proposal — never invents labels", () => {
    expect(parseMediaLabelReply("")).toBeNull();
    expect(parseMediaLabelReply("not json")).toBeNull();
    expect(parseMediaLabelReply('{"category":null,"tags":[]}')).toBeNull();
    expect(parseMediaLabelReply("[1,2,3]")).toBeNull();
  });
});

describe("enhance prompt and image-edit plumbing", () => {
  it("demands the product standard: white bg, centered, aligned", () => {
    expect(MEDIA_ENHANCE_PROMPT).toContain("white background");
    expect(MEDIA_ENHANCE_PROMPT).toContain("centered");
    expect(MEDIA_ENHANCE_PROMPT.toLowerCase()).toContain("align");
  });

  it("builds the /images/edits URL without doubled slashes", () => {
    expect(imageEditsUrl("https://gw.example.com/v1/")).toBe("https://gw.example.com/v1/images/edits");
    expect(imageEditsUrl("https://gw.example.com/v1")).toBe("https://gw.example.com/v1/images/edits");
  });

  it("extracts b64 or url replies and refuses anything else", () => {
    expect(parseImageEditReply({ data: [{ b64_json: "abc" }] })).toEqual({ b64: "abc" });
    expect(parseImageEditReply({ data: [{ url: "https://x/y.png" }] })).toEqual({ url: "https://x/y.png" });
    expect(parseImageEditReply({ data: [{ url: "javascript:alert(1)" }] })).toBeNull();
    expect(parseImageEditReply({ data: [] })).toBeNull();
    expect(parseImageEditReply(null)).toBeNull();
    expect(parseImageEditReply("x")).toBeNull();
  });
});
