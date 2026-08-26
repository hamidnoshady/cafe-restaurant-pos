import { createElement } from "react";
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

  it("can keep compact numeric identifiers ungrouped", () => {
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
