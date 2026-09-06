/**
 * Phase 38 Wave 2 (issue #380) — Markdown ⇄ Payload Lexical, the pure half.
 *
 * The app's internal contract for post bodies is Markdown (the assistant
 * writes it, `ai-markdown.tsx` renders it); Payload stores a Lexical tree.
 * This module translates at the boundary in both directions and is
 * **round-trip tested** (`payload-content.test.ts`): for the subset below,
 * `lexicalToMarkdown(markdownToLexical(md)) === md`, so an edit made here and
 * saved back does not silently eat the owner's formatting.
 *
 * The supported subset — deliberately small, and exactly what a product post
 * needs:
 *
 *   - paragraphs (blank-line separated)
 *   - headings `#` … `###`
 *   - unordered lists (`- item`) and ordered lists (`1. item`)
 *   - `**bold**`, `*italic*`, `[text](url)` inline
 *   - a line `---` as a horizontal rule
 *
 * Anything outside it (tables, images, nested lists, HTML) is carried through
 * as a plain paragraph; a Lexical node type this module does not know is
 * flattened to its text. That is the accepted cost of not shipping a second
 * rich-text editor — but the *known* subset must survive a round trip, and
 * the test pins it.
 *
 * `simpleLexicalRoot`/`lexicalToPlainText` in `cms/types.ts` predate this and
 * remain for the older website screen; new code goes through here.
 */
import type { LexicalRoot } from "../../cms/types";

type Direction = "rtl" | "ltr";

interface TextNode {
  type: "text";
  text: string;
  format: number;
  detail: 0;
  mode: "normal";
  style: "";
  version: 1;
}
interface LinkNode {
  type: "link";
  children: TextNode[];
  fields: { url: string; newTab?: boolean; linkType: "custom" };
  direction: Direction;
  format: "";
  indent: 0;
  version: 3;
}
type InlineNode = TextNode | LinkNode;

interface BlockBase {
  direction: Direction;
  format: "";
  indent: 0;
  version: 1;
}
interface ParagraphNode extends BlockBase {
  type: "paragraph";
  children: InlineNode[];
  textFormat: 0;
  textStyle: "";
}
interface HeadingNode extends BlockBase {
  type: "heading";
  tag: "h1" | "h2" | "h3";
  children: InlineNode[];
}
interface ListItemNode extends BlockBase {
  type: "listitem";
  children: InlineNode[];
  value: number;
}
interface ListNode extends BlockBase {
  type: "list";
  listType: "bullet" | "number";
  tag: "ul" | "ol";
  start: 1;
  children: ListItemNode[];
}
interface RuleNode {
  type: "horizontalrule";
  version: 1;
}
type BlockNode = ParagraphNode | HeadingNode | ListNode | RuleNode;

const BOLD = 1;
const ITALIC = 2;

/** Persian/Arabic script anywhere in the text ⇒ RTL. */
export function detectDirection(text: string): Direction {
  return /[\u0600-\u06FF]/.test(text) ? "rtl" : "ltr";
}

// ---------------------------------------------------------------------------
// Markdown → Lexical
// ---------------------------------------------------------------------------

function text(value: string, format = 0): TextNode {
  return { type: "text", text: value, format, detail: 0, mode: "normal", style: "", version: 1 };
}

/** Inline parse: `**bold**`, `*italic*`, `[text](url)`. Left to right, no nesting across a link. */
export function parseInline(source: string, direction: Direction): InlineNode[] {
  const nodes: InlineNode[] = [];
  const pattern = /\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*]+)\*/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) nodes.push(text(source.slice(last, index)));
    if (match[1] !== undefined) {
      nodes.push({
        type: "link",
        children: [text(match[1])],
        fields: { url: match[2], newTab: false, linkType: "custom" },
        direction,
        format: "",
        indent: 0,
        version: 3,
      });
    } else if (match[3] !== undefined) {
      nodes.push(text(match[3], BOLD));
    } else if (match[4] !== undefined) {
      nodes.push(text(match[4], ITALIC));
    }
    last = index + match[0].length;
  }
  if (last < source.length) nodes.push(text(source.slice(last)));
  return nodes.length ? nodes : [text("")];
}

function block(direction: Direction): BlockBase {
  return { direction, format: "", indent: 0, version: 1 };
}

export function markdownToLexical(markdown: string): LexicalRoot {
  const direction = detectDirection(markdown);
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: BlockNode[] = [];
  let paragraph: string[] = [];
  let list: ListNode | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({
      ...block(direction),
      type: "paragraph",
      children: parseInline(paragraph.join(" "), direction),
      textFormat: 0,
      textStyle: "",
    });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (/^-{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      blocks.push({ type: "horizontalrule", version: 1 });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        ...block(direction),
        type: "heading",
        tag: `h${heading[1].length}` as HeadingNode["tag"],
        children: parseInline(heading[2], direction),
      });
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed);
    const numbered = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (bullet || numbered) {
      flushParagraph();
      const listType: ListNode["listType"] = bullet ? "bullet" : "number";
      if (!list || list.listType !== listType) {
        flushList();
        list = { ...block(direction), type: "list", listType, tag: bullet ? "ul" : "ol", start: 1, children: [] };
      }
      const current: ListNode = list;
      current.children.push({
        ...block(direction),
        type: "listitem",
        children: parseInline((bullet ?? numbered)![1], direction),
        value: current.children.length + 1,
      });
      continue;
    }
    flushList();
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushList();

  if (blocks.length === 0) {
    blocks.push({ ...block(direction), type: "paragraph", children: [text("")], textFormat: 0, textStyle: "" });
  }
  return { root: { type: "root", children: blocks, direction, format: "", indent: 0, version: 1 } };
}

// ---------------------------------------------------------------------------
// Lexical → Markdown
// ---------------------------------------------------------------------------

function inlineToMarkdown(nodes: unknown[]): string {
  let out = "";
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as { type?: string; text?: string; format?: number; children?: unknown[]; fields?: { url?: string } };
    if (n.type === "text") {
      const format = typeof n.format === "number" ? n.format : 0;
      let value = n.text ?? "";
      if (format & BOLD) value = `**${value}**`;
      else if (format & ITALIC) value = `*${value}*`;
      out += value;
    } else if (n.type === "link" || n.type === "autolink") {
      const label = inlineToMarkdown(n.children ?? []);
      const url = n.fields?.url ?? "";
      out += url ? `[${label}](${url})` : label;
    } else if (n.type === "linebreak") {
      out += " ";
    } else if (Array.isArray(n.children)) {
      out += inlineToMarkdown(n.children);
    }
  }
  return out;
}

export function lexicalToMarkdown(root: LexicalRoot | null | undefined): string {
  const children = (root?.root?.children ?? []) as unknown[];
  const parts: string[] = [];
  for (const node of children) {
    if (!node || typeof node !== "object") continue;
    const n = node as {
      type?: string;
      tag?: string;
      listType?: string;
      children?: unknown[];
    };
    switch (n.type) {
      case "heading": {
        const level = Number(String(n.tag ?? "h2").replace(/^h/, "")) || 2;
        parts.push(`${"#".repeat(Math.min(3, Math.max(1, level)))} ${inlineToMarkdown(n.children ?? [])}`);
        break;
      }
      case "list": {
        const items = (n.children ?? []) as { children?: unknown[] }[];
        const numbered = n.listType === "number";
        parts.push(
          items
            .map((item, index) => `${numbered ? `${index + 1}.` : "-"} ${inlineToMarkdown(item.children ?? [])}`)
            .join("\n"),
        );
        break;
      }
      case "horizontalrule":
        parts.push("---");
        break;
      case "paragraph":
      default: {
        const line = inlineToMarkdown(n.children ?? []).trim();
        if (line) parts.push(line);
        break;
      }
    }
  }
  return parts.join("\n\n");
}
