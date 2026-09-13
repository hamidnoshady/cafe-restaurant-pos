/**
 * Regression tests for the inventory workspace's responsive redesign.
 *
 * Same technique as ../design-lint.test.ts — grep the source, because every
 * one of these bugs was a *source pattern*, not a behaviour a unit could
 * exercise: a CSS selector that missed the combobox trigger, a fixed
 * four-column grid with no breakpoint, a leftover native <select>, a banner
 * the menu had already replaced. Each rule here failed on the pre-fix code
 * and pins the fix so it cannot drift back.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const INVENTORY_DIR = fileURLToPath(new URL("./", import.meta.url));
const SRC_DIR = resolve(INVENTORY_DIR, "../../..");

function read(rel: string): string {
  return readFileSync(join(INVENTORY_DIR, rel), "utf8");
}

/** Every non-test source file of the workspace, as [name, content]. */
function sectionFiles(): Array<[string, string]> {
  return readdirSync(INVENTORY_DIR)
    .filter((name) => /\.(tsx|ts|css)$/.test(name) && !/\.test\.ts$/.test(name))
    .map((name) => [name, read(name)]);
}

describe("touch-height rule (the 'tiny selects' bug)", () => {
  const css = read("inventory-workspace.module.css");

  it("covers the SearchableSelect trigger (aria-haspopup=listbox)", () => {
    // The workspace's 3.25rem min-height once matched only input/select/
    // textarea/Button — SearchableSelect renders a plain <button>, so every
    // dropdown sat a head shorter than the field beside it.
    expect(css).toMatch(/button\[aria-haspopup="listbox"\]/);
  });

  it("covers the JalaliDatePicker trigger (aria-haspopup=dialog)", () => {
    expect(css).toMatch(/button\[aria-haspopup="dialog"\]/);
  });

  it("exempts checkboxes and radios, which a 3.25rem height misaligns", () => {
    expect(css).toMatch(
      /input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)/,
    );
    // The bare `input` selector must not survive alongside the guarded one.
    expect(css).not.toMatch(/^\s*\.workspace :global\(input\),\s*$/m);
  });

  it("still gives every control the same 3.25rem floor", () => {
    expect(css).toMatch(/min-height:\s*3\.25rem/);
  });
});

describe("the primitives keep the hooks the CSS rule targets", () => {
  // The workspace CSS reaches the trigger buttons *through* aria-haspopup.
  // If either primitive ever drops or renames the attribute, the selector
  // silently stops matching and the tiny-selects bug returns with no local
  // diff in the inventory folder — so the contract is pinned here.
  it("SearchableSelect's trigger declares aria-haspopup=listbox", () => {
    const src = readFileSync(
      join(SRC_DIR, "components/ui/searchable-select.tsx"),
      "utf8",
    );
    expect(src).toMatch(/aria-haspopup="listbox"/);
  });

  it("JalaliDatePicker's trigger declares aria-haspopup=dialog", () => {
    const src = readFileSync(
      join(SRC_DIR, "app/dashboard/jalali-date-picker.tsx"),
      "utf8",
    );
    expect(src).toMatch(/aria-haspopup="dialog"/);
  });
});

describe("low-stock banner removal", () => {
  const manager = read("inventory-manager.tsx");

  it("no longer renders the «هشدار کمبود موجودی» banner", () => {
    expect(manager).not.toContain("هشدار کمبود موجودی");
  });

  it("no longer fetches /api/inventory/low-stock or subscribes to its event", () => {
    // The section-level views (موجودی انبار filters, لیست انبارها badges)
    // own low stock now; the workspace shell must not re-grow its own copy.
    expect(manager).not.toContain("/api/inventory/low-stock");
    expect(manager).not.toContain("inventory.low_stock");
    expect(manager).not.toMatch(/\buseRealtime\b/);
    expect(manager).not.toMatch(/\bLowStockItem\b/);
  });
});

describe("select controls are the shared combobox", () => {
  it("no section renders a native <select>", () => {
    // A native <select> gets neither the type-to-filter of SearchableSelect
    // nor the workspace styling; the barcodes item picker was the last one.
    for (const [name, content] of sectionFiles()) {
      expect(content, `${name} still renders a native <select>`).not.toMatch(
        /<select[\s>]/,
      );
    }
  });
});

describe("responsive grids", () => {
  it("every arbitrary-value column template is breakpoint-gated", () => {
    // `grid-cols-[minmax(0,2fr)_…]` with no prefix is exactly the shape that
    // crushed the ثبت رسید/حواله item combobox on phones: the columns apply
    // at every width. A fixed template must only kick in from a breakpoint
    // (sm:/md:/lg:/xl:), leaving the base layout a stack.
    const ungated = /(?<![a-z]:)(?<!:)\bgrid-cols-\[/;
    for (const [name, content] of sectionFiles()) {
      for (const [index, line] of content.split("\n").entries()) {
        expect(
          ungated.test(line),
          `${name}:${index + 1} uses an un-gated fixed column template: ${line.trim()}`,
        ).toBe(false);
      }
    }
  });
});

describe("the redesigned line editors", () => {
  it("ثبت رسید/حواله: lines are labeled mini-cards below md, a grid from md up", () => {
    const form = read("document-form-section.tsx");
    // The header row naming the columns only exists where the columns do.
    expect(form).toMatch(/hidden md:grid/);
    // Each line starts as a single-column bordered card and only picks the
    // fixed template up at md; the per-field labels flip to sr-only there.
    expect(form).toMatch(/grid-cols-1[^"]*md:grid-cols-\[/);
    expect(form).toMatch(/md:sr-only/);
  });

  it("خرید: settlement and supplier pickers take a full mobile row (col-span-2)", () => {
    const purchases = read("purchases-section.tsx");
    const pickerRows = purchases.match(/col-span-2 grid min-w-0 gap-1/g) ?? [];
    expect(pickerRows.length).toBeGreaterThanOrEqual(2);
    // The old shape — a fixed min-width picker squeezed into half a 2-col
    // grid — must not return.
    expect(purchases).not.toMatch(/min-w-36 max-w-full gap-1/);
  });

  it("خرید: the row status is a StatusBadge, not a bare text node among buttons", () => {
    const purchases = read("purchases-section.tsx");
    expect(purchases).toMatch(/StatusBadge tone=\{STATUS_TONES\[p\.status\]\}/);
    expect(purchases).toMatch(/const STATUS_TONES/);
  });
});

describe("numeric fields", () => {
  it("no raw <input> carries a numeric/decimal inputMode — PersianNumberInput owns those", () => {
    // A raw numeric <input> can't show Persian digits or the thousands
    // separator; the invoice-OCR panel's quantity/amount fields were the
    // last two. Match each <input …> tag and reject numeric input modes.
    const inputTag = /<input\b[^>]*?(?:\/>|>)/gs;
    for (const [name, content] of sectionFiles()) {
      if (!name.endsWith(".tsx")) continue;
      for (const match of content.matchAll(inputTag)) {
        expect(
          /inputMode="(?:decimal|numeric)"/.test(match[0]),
          `${name} renders a raw numeric <input>; use PersianNumberInput: ${match[0].slice(0, 120)}`,
        ).toBe(false);
      }
    }
  });
});

describe("section spacing", () => {
  it("keeps the canonical space-y-4 sm:space-y-5 rhythm (no stray space-y-6 stacks)", () => {
    for (const [name, content] of sectionFiles()) {
      expect(content, `${name} reverts to the old space-y-6 stack`).not.toMatch(
        /className="space-y-6"/,
      );
    }
  });
});
