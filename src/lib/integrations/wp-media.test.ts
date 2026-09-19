import { describe, expect, it } from "vitest";
import { isWpMediaKind, safeWpExternalUrl, wpMediaKindForMime } from "./wp-media";

describe("WordPress media MIME groups", () => {
  it("groups image, video and audio MIME types and treats every other file as a document", () => {
    expect(wpMediaKindForMime("image/webp")).toBe("image");
    expect(wpMediaKindForMime("VIDEO/mp4")).toBe("video");
    expect(wpMediaKindForMime(" audio/mpeg ")).toBe("audio");
    expect(wpMediaKindForMime("application/pdf")).toBe("document");
    expect(wpMediaKindForMime(null)).toBe("document");
  });

  it("accepts only the filter values the API understands", () => {
    for (const value of ["all", "image", "video", "audio", "document"]) {
      expect(isWpMediaKind(value)).toBe(true);
    }
    expect(isWpMediaKind("attachment")).toBe(false);
    expect(isWpMediaKind(null)).toBe(false);
  });
});

describe("WordPress external media URLs", () => {
  it("allows ordinary absolute HTTP and HTTPS links", () => {
    expect(safeWpExternalUrl("https://shop.example.com/uploads/عکس.jpg")).toBe(
      "https://shop.example.com/uploads/%D8%B9%DA%A9%D8%B3.jpg",
    );
    expect(safeWpExternalUrl(" http://cdn.example.com/file.pdf ")).toBe("http://cdn.example.com/file.pdf");
  });

  it("rejects executable, local, credential-bearing and oversized href values", () => {
    expect(safeWpExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeWpExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(safeWpExternalUrl("/wp-content/a.jpg")).toBeNull();
    expect(safeWpExternalUrl("https://user:pass@shop.example.com/a.jpg")).toBeNull();
    expect(safeWpExternalUrl(`https://shop.example.com/${"a".repeat(2050)}`)).toBeNull();
  });
});
