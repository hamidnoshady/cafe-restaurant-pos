import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/** Strip comments so a rule cannot be satisfied (or broken) by prose. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const SECTION_SOURCE = code(read("./customers-section.tsx"));

/**
 * Regression cover for the deep-linked ("pinned") customer.
 *
 * Accounting, the CRM and the campaign builder all link into this screen with
 * `?customer=<id>`. When that customer is not on the currently loaded page the
 * section fetches them separately and prepends them — but only the *mobile*
 * card list read that collection; the desktop `DataTable` still mapped the raw
 * `customers` page. The result was a deep link that worked on a phone and
 * silently showed nothing on a desktop.
 *
 * The fix is one canonical display collection. These tests pin that: `rows` is
 * the only thing either breakpoint maps over.
 */
describe("Growth customers — the pinned/deep-linked customer", () => {
  it("builds one canonical display collection that includes the pinned customer", () => {
    expect(SECTION_SOURCE).toMatch(/const rows = useMemo\(/);
    expect(SECTION_SOURCE).toMatch(/return \[pinned, \.\.\.list\]/);
  });

  it("renders the desktop table from that collection, not from the raw page", () => {
    const table = SECTION_SOURCE.slice(
      SECTION_SOURCE.indexOf("<DataTableBody>"),
      SECTION_SOURCE.indexOf("</DataTableBody>"),
    );
    expect(table.length).toBeGreaterThan(0);
    expect(table).toMatch(/\{rows\.map\(\(customer\) =>/);
    expect(table).not.toMatch(/\{customers\.map\(/);
  });

  it("renders the mobile card list from the same collection", () => {
    const mobile = SECTION_SOURCE.slice(SECTION_SOURCE.indexOf("lg:hidden"));
    expect(mobile).toMatch(/\{rows\.map\(\(customer\) =>/);
    expect(mobile).not.toMatch(/\{customers\.map\(/);
  });

  it("never maps the raw page collection anywhere in the render tree", () => {
    // The whole point of the fix: `customers` is page state, `rows` is what is
    // displayed. A second `customers.map` anywhere re-forks the two.
    expect(SECTION_SOURCE).not.toMatch(/customers\.map\(\(customer\)/);
  });

  it("keeps the empty state keyed to the display collection too", () => {
    expect(SECTION_SOURCE).toMatch(/rows\.length === 0/);
  });
});
