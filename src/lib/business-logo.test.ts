import { describe, expect, it } from "vitest";
import {
  LOGO_MAX_BYTES,
  buildBusinessLogo,
  hasMatchingLogoSignature,
  isStoredLogo,
  isValidLogo,
} from "./business-logo";

const PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("business logo upload boundary", () => {
  it("accepts the four supported image types up to the cap", () => {
    expect(isValidLogo({ mimeType: "image/png", byteLength: 1 })).toBe(true);
    expect(isValidLogo({ mimeType: "image/jpeg", byteLength: LOGO_MAX_BYTES })).toBe(true);
    expect(isValidLogo({ mimeType: "image/webp", byteLength: 100 })).toBe(true);
    expect(isValidLogo({ mimeType: "image/svg+xml", byteLength: 100 })).toBe(true);
  });

  it("refuses an empty file, an oversized one, and a non-image type", () => {
    expect(isValidLogo({ mimeType: "image/png", byteLength: 0 })).toBe(false);
    expect(isValidLogo({ mimeType: "image/png", byteLength: LOGO_MAX_BYTES + 1 })).toBe(false);
    expect(isValidLogo({ mimeType: "application/pdf", byteLength: 100 })).toBe(false);
  });

  it("does not trust the declared type unless the bytes match it", () => {
    expect(hasMatchingLogoSignature("image/png", PNG_HEADER)).toBe(true);
    expect(hasMatchingLogoSignature("image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(hasMatchingLogoSignature("image/png", new TextEncoder().encode("<script>alert(1)</script>"))).toBe(false);
  });

  it("accepts a plain SVG but refuses one carrying script (it renders in the agent's browser)", () => {
    const plain = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    const nasty = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/x")</script></svg>');
    expect(hasMatchingLogoSignature("image/svg+xml", plain)).toBe(true);
    expect(hasMatchingLogoSignature("image/svg+xml", nasty)).toBe(false);
  });

  it("builds a data URL the templates can drop straight into an <img>", () => {
    const logo = buildBusinessLogo({ mimeType: "image/png", bytes: PNG_HEADER });
    expect(logo.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(logo.byteLength).toBe(PNG_HEADER.byteLength);
    expect(isStoredLogo(logo)).toBe(true);
  });

  it("treats a cleared or malformed stored value as no logo", () => {
    expect(isStoredLogo(null)).toBe(false);
    expect(isStoredLogo({ dataUrl: "https://example.com/logo.png", mimeType: "image/png" })).toBe(false);
  });
});
