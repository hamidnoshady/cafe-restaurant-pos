import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PersianNumberInput } from "./persian-number-input";

describe("PersianNumberInput", () => {
  it("renders a text control with Persian digits, grouped thousands, and a Persian decimal mark", () => {
    const html = renderToStaticMarkup(
      createElement(PersianNumberInput, {
        value: "1250000.5",
        inputMode: "decimal",
      }),
    );

    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="۱٬۲۵۰٬۰۰۰٫۵"');
  });

  it("never forwards a native pattern to the localized DOM value", () => {
    const html = renderToStaticMarkup(
      createElement(PersianNumberInput, {
        value: "2030",
        inputMode: "decimal",
        // Runtime guard for JavaScript/spread callers; TypeScript callers are
        // intentionally prevented from supplying this prop.
        pattern: "[0-9]+",
      } as ComponentProps<typeof PersianNumberInput> & { pattern: string }),
    );

    expect(html).toContain('value="۲٬۰۳۰"');
    expect(html).not.toContain("pattern=");
  });

  it("does not silently turn a disallowed negative or fraction into another value", () => {
    const html = renderToStaticMarkup(
      createElement(PersianNumberInput, {
        value: "-12.5",
        allowNegative: false,
        allowDecimal: false,
      }),
    );

    expect(html).toContain('value="-۱۲٫۵"');
  });

  it("can keep compact technical numeric values ungrouped", () => {
    const html = renderToStaticMarkup(
      createElement(PersianNumberInput, {
        value: "1234567890",
        grouping: false,
        allowNegative: false,
      }),
    );

    expect(html).toContain('value="۱۲۳۴۵۶۷۸۹۰"');
    expect(html).not.toContain("٬");
  });
});
