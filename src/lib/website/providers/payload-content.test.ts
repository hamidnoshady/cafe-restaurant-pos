import { describe, expect, it } from "vitest";
import { detectDirection, lexicalToMarkdown, markdownToLexical, parseInline } from "./payload-content";

const SAMPLE = [
  "# قهوهٔ تازهٔ اتیوپی",
  "",
  "این هفته **قهوهٔ اتیوپی** با عطر گل و *طعم مرکبات* رسید.",
  "",
  "## ویژگی‌ها",
  "",
  "- برشت روشن",
  "- بسته‌بندی ۲۵۰ گرمی",
  "- قیمت: ۴۵۰٬۰۰۰ تومان",
  "",
  "1. سفارش دهید",
  "2. تحویل بگیرید",
  "",
  "---",
  "",
  "بیشتر بخوانید: [منوی ما](https://example.test/menu)",
].join("\n");

describe("Phase 38 Wave 2 — Markdown ⇄ Lexical", () => {
  it("round-trips the supported subset without loss", () => {
    const lexical = markdownToLexical(SAMPLE);
    expect(lexicalToMarkdown(lexical)).toBe(SAMPLE);
  });

  it("is idempotent across a second trip", () => {
    const once = lexicalToMarkdown(markdownToLexical(SAMPLE));
    const twice = lexicalToMarkdown(markdownToLexical(once));
    expect(twice).toBe(once);
  });

  it("produces the Lexical shapes Payload expects", () => {
    const { root } = markdownToLexical("# عنوان\n\nمتن\n\n- یک\n- دو");
    expect(root.type).toBe("root");
    expect(root.direction).toBe("rtl");
    const types = (root.children as { type: string }[]).map((c) => c.type);
    expect(types).toEqual(["heading", "paragraph", "list"]);
    const list = root.children[2] as { listType: string; tag: string; children: { type: string; value: number }[] };
    expect(list.listType).toBe("bullet");
    expect(list.tag).toBe("ul");
    expect(list.children.map((c) => c.value)).toEqual([1, 2]);
  });

  it("detects direction from script, so a Latin post is LTR", () => {
    expect(detectDirection("Fresh Ethiopian coffee")).toBe("ltr");
    expect(detectDirection("قهوه")).toBe("rtl");
    expect(markdownToLexical("Hello").root.direction).toBe("ltr");
  });

  it("folds a soft-wrapped paragraph into one paragraph", () => {
    const md = "خط اول\nخط دوم";
    expect(lexicalToMarkdown(markdownToLexical(md))).toBe("خط اول خط دوم");
  });

  it("never returns an empty root — Payload rejects one", () => {
    const { root } = markdownToLexical("");
    expect(root.children).toHaveLength(1);
    expect((root.children[0] as { type: string }).type).toBe("paragraph");
    expect(lexicalToMarkdown(markdownToLexical(""))).toBe("");
  });

  it("flattens an unknown Lexical node to its text rather than dropping it", () => {
    const md = lexicalToMarkdown({
      root: {
        type: "root",
        direction: "rtl",
        format: "",
        indent: 0,
        version: 1,
        children: [
          {
            type: "quote",
            children: [{ type: "text", text: "نقل قول", format: 0 }],
          },
        ],
      },
    });
    expect(md).toBe("نقل قول");
  });

  it("parses inline marks left to right", () => {
    const nodes = parseInline("a **b** c *d* [e](https://x.y)", "ltr");
    expect(nodes.map((n) => (n.type === "text" ? `${n.format}:${n.text}` : `link:${n.fields.url}`))).toEqual([
      "0:a ",
      "1:b",
      "0: c ",
      "2:d",
      "0: ",
      "link:https://x.y",
    ]);
  });
});
