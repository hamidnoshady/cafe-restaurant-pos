/**
 * The *structural* half of the design lint.
 *
 * `design-lint.test.ts` bans spellings — a cool neutral, a heavy shadow, a raw
 * hex. This test bans **shapes**: a screen that hand-builds a table, a chip or
 * a KPI tile instead of composing the shared primitive. Those bypasses are what
 * actually drifted the product — every one of them was individually "correct"
 * (warm colours, right radius) and collectively three different tables.
 *
 * Why a structural check and not a grep: the giveaway for a hand-rolled table
 * is a `<thead>` whose file never imports `DataTable`, and for a chip it is a
 * `<button>` carrying both `aria-pressed` and an amber fill. Neither is
 * expressible as a substring without either missing the real cases or failing
 * legitimate ones. So each rule below walks the JSX with a small tag scanner
 * and asserts on the element's own attributes, not on the file's text.
 *
 * **Operational variations are not violations.** The POS sell screen, the KDS,
 * the floor plan and the waiter board are an approved dense dialect of this
 * same system (docs/design-system.md § Realms, realm 2). They are exempt *by path*,
 * listed once in `OPERATIONAL_SURFACES` with the reason — not silently skipped
 * and not exempt from the colour rules, which still apply to them in
 * `design-lint.test.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_DIR = fileURLToPath(new URL("./", import.meta.url));
const APP_ROOT = join(DASHBOARD_DIR, "..");

/**
 * Full-screen operational surfaces: the approved dense variation. They compose
 * the same tokens and the same colour roles, but their layout is deliberately
 * not a `PageHeader` page — forcing the ordinary table/chip shapes onto them
 * would make them worse, which is exactly the "don't copy POS onto CRM, and
 * don't copy CRM onto POS" rule in the brief.
 */
const OPERATIONAL_SURFACES: readonly string[] = [
  "dashboard/pos/",
  "dashboard/kitchen/",
  "dashboard/floor/",
  "dashboard/waiter/",
  "dashboard/delivery/",
  "dashboard/watch/",
  "dashboard/orders/ops-styles.ts",
];

/** The shadcn layer defines primitives; the platform console is a separate identity. */
const EXCLUDED_PREFIXES: readonly string[] = ["platform/", "components/ui/"];

/**
 * Screens whose table has **not** been migrated onto `DataTable` yet.
 *
 * This is a shrinking, ordered work list — not a baseline to live with. It is
 * spelled out file by file (rather than the rule being switched off) so the
 * remaining work is visible in the repo, reviewable in a diff, and impossible
 * to grow silently: adding a *new* hand-rolled table fails the test, because a
 * new file is not on this list. Deleting the last entry deletes the constant.
 *
 * Ordered by user-visible impact — the screens with an approved reference
 * screenshot first, then the rest of Accounting, then the operational
 * inventory/stock pages, then the remaining long tail.
 *
 * Progress: 26 of 36 migrated (trial balance, growth customers, CMS billing,
 * CMS product sync, inventory warehouses, plus the shared report table's
 * consumers are unchanged pending a `report-table.tsx` refactor).
 */
const TABLE_MIGRATION_BACKLOG: readonly string[] = [
  // — Reports: all four share report-table.tsx, which should be migrated once —
  "dashboard/reports/drill-down-panel.tsx",
  "dashboard/reports/ledger-report-view.tsx",
  "dashboard/reports/report-table.tsx",
  "dashboard/reports/shift-orders-section.tsx",
  // — Long tail —
  "dashboard/backup/backup-manager.tsx",
  "dashboard/locations/locations-manager.tsx",
  "dashboard/parties/parties-section.tsx",
  "setup/accounts/page.tsx",
];

interface Finding {
  relPath: string;
  line: number;
  detail: string;
}

function walk(root: string, prefix: string): { relPath: string; absPath: string }[] {
  const out: { relPath: string; absPath: string }[] = [];
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, `${prefix}${entry}/`));
      continue;
    }
    if (!/\.tsx$/.test(entry) || entry.includes(".test.")) continue;
    out.push({ relPath: `${prefix}${entry}`, absPath: full });
  }
  return out;
}

/** Every tenant-facing .tsx under src/app, minus the excluded realms. */
function collectFiles() {
  return walk(APP_ROOT, "")
    .filter(({ relPath }) => !EXCLUDED_PREFIXES.some((p) => relPath.startsWith(p)))
    .map(({ relPath, absPath }) => ({
      relPath,
      absPath,
      operational: OPERATIONAL_SURFACES.some((p) => relPath.startsWith(p)),
    }))
    .sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * Every JSX opening tag in `source`, with its raw attribute text.
 *
 * Deliberately a scanner rather than a full parser: it reads `<Tag …>` spans,
 * tracking quotes and brace depth so a `className={cond ? "a>b" : "c"}` or a
 * nested arrow function inside a prop doesn't end the tag early. That is enough
 * structure for "which element is this, and what props does it carry", which is
 * all these rules ask, and it keeps the test dependency-free.
 */
function jsxTags(source: string): { name: string; attrs: string; index: number }[] {
  const tags: { name: string; attrs: string; index: number }[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== "<") continue;
    const nameMatch = /^<([A-Za-z][\w.]*)/.exec(source.slice(i, i + 64));
    if (!nameMatch) continue;
    let j = i + nameMatch[0].length;
    let depth = 0;
    let quote: string | null = null;
    while (j < source.length) {
      const ch = source[j];
      if (quote) {
        if (ch === quote && source[j - 1] !== "\\") quote = null;
      } else if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
      } else if (ch === ">" && depth === 0) {
        break;
      }
      j++;
    }
    tags.push({ name: nameMatch[1], attrs: source.slice(i + nameMatch[0].length, j), index: i });
    i = j;
  }
  return tags;
}

const lineOf = (source: string, index: number) => source.slice(0, index).split("\n").length;

describe("primitive lint — approved components are composed, not re-implemented", () => {
  const files = collectFiles();
  const contents = new Map(files.map(({ relPath, absPath }) => [relPath, readFileSync(absPath, "utf8")]));

  it("scans a plausible number of files (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  /**
   * A `<thead>` means the file is drawing a table's chrome. The approved table
   * is `DataTable` (src/app/dashboard/data-table.tsx), which owns the panel,
   * the scroller, the warm header wash and the row hairline.
   */
  it("data tables compose DataTable rather than hand-rolling <thead>", () => {
    const findings: Finding[] = [];
    for (const { relPath, operational } of files) {
      if (operational) continue;
      const source = contents.get(relPath)!;
      if (relPath === "dashboard/data-table.tsx") continue;
      if (/from "[^"]*data-table"/.test(source)) continue;
      if (TABLE_MIGRATION_BACKLOG.includes(relPath)) continue;
      for (const tag of jsxTags(source)) {
        if (tag.name !== "thead") continue;
        findings.push({
          relPath,
          line: lineOf(source, tag.index),
          detail: "<thead> without importing DataTable",
        });
      }
    }
    expect(
      findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n"),
      [
        `Hand-rolled table chrome in ${findings.length} place(s).`,
        "The approved table is <DataTable> + <DataTableHead>/<Th>/<Td>",
        "(src/app/dashboard/data-table.tsx): it states the panel, the warm",
        "header wash and the row hairline once. A screen that spells its own",
        "<thead> forks the header wash, which is how three different table",
        "headers reached production. docs/design-system.md § Tables.",
        "",
        findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n") || "  (none)",
      ].join("\n"),
    ).toBe("");
  });

  /**
   * A toggle button carrying an amber fill is a filter chip. The approved chip
   * is `FilterChip` (src/app/dashboard/filters.tsx), whose `dense` prop is the
   * POS's taller target — so an operational screen has no reason to hand-roll
   * one either, and these files are *not* exempt from this rule.
   */
  it("filter chips compose FilterChip rather than re-deriving the amber toggle", () => {
    const findings: Finding[] = [];
    for (const { relPath } of files) {
      const source = contents.get(relPath)!;
      // The three files that *define* an approved amber toggle: the chip
      // itself, the tab strip (TabBar) and the in-page menu (SectionNav).
      if (
        relPath === "dashboard/filters.tsx" ||
        relPath === "dashboard/page-chrome.tsx" ||
        relPath === "dashboard/section-nav.tsx"
      ) {
        continue;
      }
      // A file that imports the chip may still render a bespoke control for a
      // different job; the rule only fires on files that never import it.
      if (/FilterChip/.test(source)) continue;
      for (const tag of jsxTags(source)) {
        if (tag.name !== "button") continue;
        if (!/aria-pressed/.test(tag.attrs)) continue;
        // The tell-tale of a re-derived chip: the amber selected fill written
        // into the button's own className, together with the pill radius. A
        // toggle that merely *contains* an amber child (a settings row with a
        // status dot, the sidebar's bottom-nav picker) is a different control
        // and must not be dragged into the chip vocabulary.
        if (!/rounded-xl/.test(tag.attrs)) continue;
        if (!/bg-amber-100\b/.test(tag.attrs)) continue;
        // A chip is a single-line pill. Three neighbouring controls share the
        // amber-selected role but are *not* chips, and forcing FilterChip onto
        // them would be the "copy one screen's pattern onto another" mistake:
        //   - a stacked tile (`flex-col`, ≥56px) — the installments source
        //     picker and the POS table picker, which carry an icon over a
        //     label and a second muted line;
        //   - a segmented control whose options divide one field's width
        //     (`flex-1`) — the party form's «نوع شخص» radio pair.
        if (/flex-col/.test(tag.attrs)) continue;
        if (/\bflex-1\b/.test(tag.attrs)) continue;
        if (/min-h-1[4-9]|min-h-2\d/.test(tag.attrs)) continue;
        findings.push({
          relPath,
          line: lineOf(source, tag.index),
          detail: "aria-pressed <button> with an amber fill",
        });
      }
    }
    expect(
      findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n"),
      [
        `Re-derived filter chips in ${findings.length} place(s).`,
        "Use <FilterChip> (src/app/dashboard/filters.tsx). Its `dense` prop",
        "carries the POS's 44px touch target, so operational density is an",
        "option of the shared chip rather than a reason to write a new one.",
        "docs/design-system.md § Chips / filters / segmented toggles.",
        "",
        findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n") || "  (none)",
      ].join("\n"),
    ).toBe("");
  });

  /**
   * `KpiRowSkeleton` already reserved the stat-row shape for every overview, so
   * a locally-defined `StatCard`/`KpiCard` means the loading state is shared
   * while the loaded state is not — which is precisely how the tiles drifted.
   */
  it("KPI tiles compose KpiCard rather than a local StatCard", () => {
    const findings: Finding[] = [];
    for (const { relPath } of files) {
      const source = contents.get(relPath)!;
      if (relPath === "dashboard/page-chrome.tsx") continue;
      for (const match of source.matchAll(/function\s+(StatCard|KpiCard|MetricCard)\s*\(/g)) {
        findings.push({
          relPath,
          line: lineOf(source, match.index!),
          detail: `local ${match[1]} definition`,
        });
      }
    }
    expect(
      findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n"),
      [
        `Locally-defined KPI tiles in ${findings.length} place(s).`,
        "Use <KpiCard>/<KpiRow> from @/app/dashboard/page-chrome — they are the",
        "loaded counterpart of KpiRowSkeleton, so the loading and loaded shapes",
        "cannot drift apart. docs/design-system.md § Stat / KPI cards.",
        "",
        findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n") || "  (none)",
      ].join("\n"),
    ).toBe("");
  });

  /**
   * The rich empty state (amber icon chip + bold title + muted line) is
   * `EmptyState`'s `title`/`icon` shape. A hand-built one is a centred flex
   * column containing a `size-12 … rounded-2xl bg-amber-100` chip.
   */
  it("rich empty states compose EmptyState rather than a hand-built icon chip", () => {
    const findings: Finding[] = [];
    for (const { relPath } of files) {
      const source = contents.get(relPath)!;
      if (relPath === "dashboard/page-chrome.tsx") continue;
      if (/EmptyState/.test(source)) continue;
      for (const tag of jsxTags(source)) {
        if (tag.name !== "span" && tag.name !== "div") continue;
        if (!/size-12/.test(tag.attrs)) continue;
        if (!/rounded-2xl/.test(tag.attrs) || !/bg-amber-100/.test(tag.attrs)) continue;
        // An amber icon chip is only an *empty state* when it sits in a centred
        // column that says "there is nothing here". The same chip decorating a
        // populated card (the billing wallet's balance, the welcome screen's
        // mode tiles) is ordinary iconography, not a bypass.
        const context = source.slice(Math.max(0, tag.index - 400), tag.index);
        if (!/items-center justify-center|text-center/.test(context)) continue;
        findings.push({
          relPath,
          line: lineOf(source, tag.index),
          detail: "hand-built amber empty-state icon chip",
        });
      }
    }
    expect(
      findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n"),
      [
        `Hand-built empty-state chrome in ${findings.length} place(s).`,
        'Use <EmptyState icon={Icon} title="…">…</EmptyState> from',
        "@/app/dashboard/page-chrome. docs/design-system.md § Empty states.",
        "",
        findings.map((f) => `  ${f.relPath}:${f.line}  ${f.detail}`).join("\n") || "  (none)",
      ].join("\n"),
    ).toBe("");
  });
});
