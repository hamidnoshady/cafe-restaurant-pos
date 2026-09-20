import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { chatAttachmentFileName, decodeImageDataUrl } from "./ai-media-persist";

/** Real PNG magic + padding, as a base64 data URL. */
function pngDataUrl(size = 32): string {
  const bytes = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

function jpegDataUrl(size = 16): string {
  const bytes = Buffer.alloc(size, 1);
  Buffer.from([0xff, 0xd8, 0xff]).copy(bytes);
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}

describe("decodeImageDataUrl", () => {
  it("decodes a valid PNG data URL to bytes with a matching sha256", () => {
    const url = pngDataUrl(40);
    const decoded = decodeImageDataUrl(url);
    expect(decoded).not.toBeNull();
    expect(decoded!.mimeType).toBe("image/png");
    expect(decoded!.bytes.byteLength).toBe(40);
    const expected = createHash("sha256").update(decoded!.bytes).digest("hex");
    expect(decoded!.sha256).toBe(expected);
  });

  it("decodes a valid JPEG data URL", () => {
    const decoded = decodeImageDataUrl(jpegDataUrl());
    expect(decoded?.mimeType).toBe("image/jpeg");
  });

  it("tolerates surrounding whitespace", () => {
    expect(decodeImageDataUrl(`  ${pngDataUrl()}  `)).not.toBeNull();
  });

  it("refuses a non-image data URL (PDF)", () => {
    expect(decodeImageDataUrl("data:application/pdf;base64,JVBERi0xLjc=")).toBeNull();
  });

  it("refuses an unsupported image type (gif)", () => {
    const bytes = Buffer.from([0x47, 0x49, 0x46, 0x38]);
    expect(decodeImageDataUrl(`data:image/gif;base64,${bytes.toString("base64")}`)).toBeNull();
  });

  it("refuses bytes whose signature does not match the claimed MIME (a script mislabeled as PNG)", () => {
    const evil = Buffer.from("<script>alert(1)</script>");
    const url = `data:image/png;base64,${evil.toString("base64")}`;
    expect(decodeImageDataUrl(url)).toBeNull();
  });

  it("refuses an empty payload and malformed strings", () => {
    expect(decodeImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(decodeImageDataUrl("not a data url")).toBeNull();
    expect(decodeImageDataUrl("")).toBeNull();
  });
});

describe("chatAttachmentFileName", () => {
  it("uses the provided name when present", () => {
    expect(chatAttachmentFileName({ kind: "image", name: "رسید.png" }, "image/png")).toBe("رسید.png");
  });

  it("falls back to a stable extension-appropriate default", () => {
    expect(chatAttachmentFileName({ kind: "image" }, "image/jpeg")).toBe("chat-attachment.jpg");
    expect(chatAttachmentFileName({ kind: "image" }, "image/png")).toBe("chat-attachment.png");
    expect(chatAttachmentFileName({ kind: "image" }, "image/webp")).toBe("chat-attachment.webp");
  });

  it("caps an over-long name at 200 chars", () => {
    const long = "x".repeat(300) + ".png";
    expect(chatAttachmentFileName({ kind: "image", name: long }, "image/png").length).toBe(200);
  });
});
