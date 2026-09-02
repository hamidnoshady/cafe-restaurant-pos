import { describe, expect, it } from "vitest";
import {
  buildKbCategoryTree,
  kbHeadingSlug,
  kbHeadings,
  kbHighlightSegments,
  kbSnippet,
  kbVideoKind,
  isKbSlug,
  normalizeSectionKeys,
  parseHttpUrl,
  stripMarkdown,
  suggestKbSlug,
} from "./knowledge";

describe("knowledge slugs", () => {
  it("accepts clean ASCII slugs only", () => {
    expect(isKbSlug("pos-basics")).toBe(true);
    expect(isKbSlug("pos")).toBe(true);
    expect(isKbSlug("pos_basics")).toBe(false);
    expect(isKbSlug("Pos-Basics")).toBe(false);
    expect(isKbSlug("-pos")).toBe(false);
    expect(isKbSlug("pos-")).toBe(false);
    expect(isKbSlug("fa-صندوق")).toBe(false);
    expect(isKbSlug("")).toBe(false);
  });

  it("suggests a slug from latin characters and drops the rest", () => {
    expect(suggestKbSlug("POS Basics")).toBe("pos-basics");
    expect(suggestKbSlug("راهنمای POS صندوق")).toBe("pos");
    expect(suggestKbSlug("  hello   world ")).toBe("hello-world");
  });

  it("suggests nothing for a fully Persian title — the console asks instead", () => {
    expect(suggestKbSlug("راهنمای صندوق")).toBe("");
  });
});

describe("kbHeadingSlug", () => {
  it("keeps Persian letters and turns spaces into dashes", () => {
    expect(kbHeadingSlug("ثبت سفارش جدید")).toBe("ثبت-سفارش-جدید");
  });

  it("turns نیم‌فاصله into a dash and strips diacritics and punctuation", () => {
    expect(kbHeadingSlug("میزبان‌ها (هاست)")).toBe("میزبان-ها-هاست");
    expect(kbHeadingSlug("ثبت‌نام: مرحلهٔ یک")).toBe("ثبت-نام-مرحله-یک");
  });

  it("lowercases latin text", () => {
    expect(kbHeadingSlug("API Token")).toBe("api-token");
  });

  it("returns an empty string for text that is only punctuation", () => {
    expect(kbHeadingSlug("!!!")).toBe("");
  });
});

describe("kbHeadings", () => {
  it("lists ##-#### headings in order with anchors, skipping the H1 title", () => {
    const md = ["# عنوان مقاله", "## بخش یک", "متن", "### جزئیات", "## بخش دو"].join("\n");
    expect(kbHeadings(md)).toEqual([
      { depth: 2, text: "بخش یک", id: "بخش-یک", line: 2 },
      { depth: 3, text: "جزئیات", id: "جزئیات", line: 4 },
      { depth: 2, text: "بخش دو", id: "بخش-دو", line: 5 },
    ]);
  });

  it("disambiguates repeated headings with a numeric suffix", () => {
    const md = "## معرفی\n## معرفی\n## معرفی";
    expect(kbHeadings(md).map((h) => h.id)).toEqual(["معرفی", "معرفی-2", "معرفی-3"]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const md = ["```markdown", "## نه یک تیتر", "```", "## بله یک تیتر", "~~~", "### هم نه", "~~~"].join("\n");
    expect(kbHeadings(md).map((h) => h.text)).toEqual(["بله یک تیتر"]);
  });

  it("strips inline marks from the heading text", () => {
    const first = kbHeadings("## فروش **آنلاین** و [سایت](https://x.test)")[0];
    expect(first.depth).toBe(2);
    expect(first.text).toBe("فروش آنلاین و سایت");
    expect(first.id).toBe("فروش-آنلاین-و-سایت");
    expect(first.line).toBe(1);
  });

  it("falls back to a stable id for a markup-only heading", () => {
    expect(kbHeadings("## ![]()")[0].id).toBe("section");
  });
});

describe("kbVideoKind", () => {
  it("classifies direct video files as a player source", () => {
    expect(kbVideoKind("https://cdn.example.com/help/pos-intro.mp4")).toBe("file");
    expect(kbVideoKind("https://cdn.example.com/a.MP4")).toBe("file");
  });

  it("classifies video-host pages as iframe embeds", () => {
    expect(kbVideoKind("https://www.aparat.com/v/abc123")).toBe("embed");
    expect(kbVideoKind("https://www.youtube.com/watch?v=abc")).toBe("embed");
  });

  it("rejects non-http and malformed URLs", () => {
    expect(kbVideoKind("file:///etc/passwd")).toBeNull();
    expect(kbVideoKind("javascript:alert(1)")).toBeNull();
    expect(kbVideoKind("not a url")).toBeNull();
    expect(kbVideoKind("")).toBeNull();
  });
});

describe("parseHttpUrl", () => {
  it("trims and parses http(s)", () => {
    expect(parseHttpUrl("  https://example.com/a ")?.host).toBe("example.com");
  });
  it("rejects everything else", () => {
    expect(parseHttpUrl("ftp://example.com")).toBeNull();
    expect(parseHttpUrl("https://bad url with space")).toBeNull();
  });
});

describe("stripMarkdown", () => {
  it("keeps prose and code, drops fence/list/heading/table markup", () => {
    const md = [
      "## سفارش",
      "- آیتم **یک**",
      "| a | b |",
      "|---|---|",
      "```ts",
      'const x = "keep me";',
      "```",
      "![کاور](https://x.test/c.png)",
    ].join("\n");
    const text = stripMarkdown(md);
    expect(text).toContain("سفارش");
    expect(text).toContain("آیتم یک");
    expect(text).toContain('const x = "keep me";');
    expect(text).toContain("کاور");
    expect(text).not.toContain("|---|");
    expect(text).not.toContain("![");
  });
});

describe("kbSnippet", () => {
  const text = stripMarkdown(
    "راهنمای کامل صندوق فروش شامل ثبت سفارش، اعمال تخفیف، تسویهٔ چندگانه و چاپ فاکتور است. در ادامه شیفت و صندوق را می‌بینید.",
  );

  it("windows around the first hit with ellipses on both sides", () => {
    const snippet = kbSnippet(text, "تخفیف", 10);
    expect(snippet).toContain("تخفیف");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("returns the leading text when the query misses (title-only hit)", () => {
    const snippet = kbSnippet(text, "هلو", 10);
    expect(snippet).toBe(stripMarkdown(text).slice(0, 20).trimEnd() + "…");
  });

  it("returns the whole text when it is short enough", () => {
    expect(kbSnippet("متن کوتاه", "", 90)).toBe("متن کوتاه");
  });
});

describe("kbHighlightSegments", () => {
  it("marks every term occurrence and keeps the misses verbatim", () => {
    const segments = kbHighlightSegments("فروش امروز و فروش دیروز", "فروش");
    expect(segments).toEqual([
      { text: "فروش", hit: true },
      { text: " امروز و ", hit: false },
      { text: "فروش", hit: true },
      { text: " دیروز", hit: false },
    ]);
  });

  it("treats regex metacharacters in the query literally", () => {
    const segments = kbHighlightSegments("قیمت (تومان) ثبت شد", "(تومان)");
    expect(segments.some((s) => s.hit && s.text === "(تومان)")).toBe(true);
  });

  it("returns the text as one miss for an empty query", () => {
    expect(kbHighlightSegments("متن", " ")).toEqual([{ text: "متن", hit: false }]);
  });
});

describe("buildKbCategoryTree", () => {
  const flat = [
    { id: "b", parentId: null, slug: "b", title: "ب", description: "", icon: "", tone: "", sortOrder: 2 },
    { id: "a", parentId: null, slug: "a", title: "الف", description: "", icon: "", tone: "", sortOrder: 1 },
    { id: "a1", parentId: "a", slug: "a1", title: "الف-۱", description: "", icon: "", tone: "", sortOrder: 0 },
  ];

  it("nests children under sorted roots", () => {
    const tree = buildKbCategoryTree(flat);
    expect(tree.map((n) => n.id)).toEqual(["a", "b"]);
    expect(tree[0].children.map((n) => n.id)).toEqual(["a1"]);
  });

  it("attaches orphans to the root instead of hiding them", () => {
    const tree = buildKbCategoryTree([...flat, { ...flat[2], id: "c1", parentId: "missing" }]);
    expect(tree.map((n) => n.id)).toContain("c1");
  });
});

describe("normalizeSectionKeys", () => {
  const known = new Set(["pos", "orders"]);

  it("keeps known keys, deduped, in order", () => {
    expect(normalizeSectionKeys(["pos", "orders", "pos"], known)).toEqual(["pos", "orders"]);
  });

  it("drops unknown keys and non-strings", () => {
    expect(normalizeSectionKeys(["pos", "nope", 3], known)).toEqual(["pos"]);
    expect(normalizeSectionKeys("pos", known)).toEqual([]);
  });
});
