import { describe, expect, it } from "vitest";
import { hasMatchingImageSignature, isValidWebsiteImage, WEBSITE_MEDIA_MAX_BYTES } from "./content-service";

describe("website featured-image server boundary", () => {
  it("permits only non-empty supported images at or below the fixed 5 MB limit", () => {
    expect(isValidWebsiteImage({ filename: "hero.webp", mimeType: "image/webp", byteLength: 1 })).toBe(true);
    expect(isValidWebsiteImage({ filename: "hero.png", mimeType: "image/png", byteLength: WEBSITE_MEDIA_MAX_BYTES })).toBe(true);
  });

  it("refuses an executable disguised with an image filename, an empty input, and an oversized image", () => {
    expect(isValidWebsiteImage({ filename: "bad.png", mimeType: "application/javascript", byteLength: 20 })).toBe(false);
    expect(isValidWebsiteImage({ filename: "", mimeType: "image/jpeg", byteLength: 20 })).toBe(false);
    expect(isValidWebsiteImage({ filename: "empty.jpg", mimeType: "image/jpeg", byteLength: 0 })).toBe(false);
    expect(isValidWebsiteImage({ filename: "large.gif", mimeType: "image/gif", byteLength: WEBSITE_MEDIA_MAX_BYTES + 1 })).toBe(false);
  });

  it("does not trust an image MIME type unless its byte signature matches", () => {
    expect(hasMatchingImageSignature("image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
    expect(hasMatchingImageSignature("image/webp", new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(true);
    expect(hasMatchingImageSignature("image/png", new TextEncoder().encode("<script>alert(1)</script>"))).toBe(false);
  });
});
