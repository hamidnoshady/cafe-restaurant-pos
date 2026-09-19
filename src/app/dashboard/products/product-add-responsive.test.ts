/** Source-level regressions for the add-product form's phone/tablet layout. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  join(fileURLToPath(new URL("./", import.meta.url)), "product-add-section.tsx"),
  "utf8",
);

describe("add-product responsive layout", () => {
  it("stacks the form and draft rail until the desktop breakpoint", () => {
    expect(source).toMatch(/lg:grid-cols-\[minmax\(0,1fr\)_19rem\]/);
    expect(source).toMatch(/<aside className="min-w-0 lg:sticky lg:top-4">/);
  });

  it("keeps the save and draft actions reachable on phones", () => {
    expect(source).toMatch(/sticky bottom-3[^\n]+lg:hidden/);
    expect(source).toContain("در حال ثبت…");
  });

  it("uses stacked base grids and only adds columns at breakpoints", () => {
    expect(source).not.toMatch(/(?<![a-z]:)(?<!:)\bgrid-cols-\[/);
    expect(source).toMatch(/sm:grid-cols-2/);
    expect(source).toMatch(/xl:grid-cols-3/);
  });

  it("keeps destructive row and draft actions at touch size", () => {
    expect(source).toMatch(/size="icon"/);
    expect(source).toMatch(/className="size-10 shrink-0 text-destructive/);
  });
});
