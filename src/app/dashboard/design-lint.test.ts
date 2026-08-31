/**
 * The executable half of docs/design-system.md's "Checking your work".
 *
 * The dashboard's look is its primitives (`page-chrome.tsx`, `section-nav.tsx`,
 * `ui.tsx`, `components/ui`) plus a short list of banned patterns — cool
 * neutrals, heavy shadows, hand-rolled page shells and card skins, `dark:`
 * variants, a bare `<h1>`. Prose alone didn't hold the line: this test greps
 * every non-test file under `src/app/dashboard` on every `npm test` run, so
 * drift fails the suite instead of waiting for a review to catch it.
 *
 * Existing violations are a documented, countable baseline — the same shape as
 * the `withoutTenantScope()` holes in `src/lib/db.ts`. Each entry below names a
 * file that already carries the pattern when this test was written. A violation
 * in a file that is *not* in its rule's baseline fails; fixing a file means
 * deleting its entry, and the hygiene check below fails while a stale entry
 * remains, so the baseline only ever shrinks.
 *
 * Rules and recipes: docs/design-system.md. Composition rules:
 * docs/ui-conventions.md.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const DASHBOARD_DIR = fileURLToPath(new URL("./", import.meta.url));

interface Rule {
  id: string;
  /** What the ban is, and what to write instead. */
  why: string;
  pattern: RegExp;
  /** Restrict the rule to certain files (e.g. only `page.tsx` routes). */
  fileFilter?: (relPath: string) => boolean;
  /**
   * Files exempt from the rule: the primitive that *defines* the pattern, or
   * files that carried it when this test was introduced (counted drift — fix
   * and delete the entry).
   */
  allowed: readonly string[];
}

/**
 * The exact card skin from `cardClass` (`rounded-2xl border border-stone-200/80
 * … bg-card`, with or without the interleaved shadow), restated instead of
 * composing `cardClass`/`SectionCard`. Tinted surfaces that rearrange the
 * pieces (amber banners, dashed panels) are bespoke layout, not this rule.
 */
const CARD_SKIN =
  /rounded-2xl border border-stone-200\/80(?: shadow-\[0_1px_2px_rgb\(41_37_36\/0\.035\)\])? bg-card/;

const RULES: readonly Rule[] = [
  {
    id: "cool neutrals",
    why: "Neutrals are the warm stone scale; gray/slate/zinc/neutral read as a different product. Use stone-* or the tokens (docs/design-system.md §Colour roles).",
    pattern: /[a-z:-]-(?:gray|slate|zinc|neutral)-\d{2,3}/,
    allowed: [],
  },
  {
    id: "heavy shadows",
    why: "Cards carry exactly one warm 1px shadow (cardClass's 0 1px 2px rgb(41 37 36/0.035)); shadow-sm/md/lg are cooler and heavier, and popovers get shadow-md only inside components/ui. See docs/design-system.md §Weight.",
    pattern: /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl)\b/,
    allowed: [
      "biometric-settings.tsx",
      "inventory/stock-counts-section.tsx",
      "jalali-date-picker.tsx",
      "ledger/account-history-panel.tsx",
      "ledger/account-statement-panel.tsx",
      "ledger/ap-section.tsx",
      "ledger/ap-statement-panel.tsx",
      "ledger/ar-section.tsx",
      "ledger/ar-statement-panel.tsx",
      "lock-screen.tsx",
      "reports/drill-down-panel.tsx",
      "shift-panel.tsx",
    ],
  },
  {
    id: "hand-rolled page shell",
    why: "The page canvas is <PageShell>; a second `mx-auto w-full max-w-[…]` spelling drifts the column. docs/design-system.md §Page frame.",
    pattern: /mx-auto w-full max-w-\[/,
    allowed: [
      // Defines PageShell.
      "page-chrome.tsx",
    ],
  },
  {
    id: "hand-rolled card chrome",
    why: "The card skin is cardClass/<SectionCard>; restating `rounded-2xl border border-stone-200/80 … bg-card` forks it, and a restyle then misses the fork. Compose cardClass instead (docs/design-system.md §Page frame, §Weight).",
    pattern: CARD_SKIN,
    allowed: [
      // Defines cardClass.
      "page-chrome.tsx",
      // Counted drift below — normalise to cardClass/SectionCard, then delete.
      "inventory/production-section.tsx",
      "inventory/purchases-section.tsx",
      "inventory/recipes-section.tsx",
      "inventory/stock-counts-section.tsx",
      "inventory/suppliers-section.tsx",
      "inventory/waste-section.tsx",
      "ledger/ap-section.tsx",
      "ledger/ar-section.tsx",
      "ledger/chart-of-accounts-section.tsx",
      "ledger/cheques-section.tsx",
      "ledger/entries-section.tsx",
      "ledger/expense-section.tsx",
      "ledger/fiscal-periods-section.tsx",
      "ledger/fixed-assets-section.tsx",
      "ledger/manual-entry-section.tsx",
      "ledger/payroll-section.tsx",
      "ledger/reconciliation-section.tsx",
      "ledger/vat-report-section.tsx",
      "settings/business-settings.tsx",
      "settings/settings-manager.tsx",
      "waiter/table-order-panel.tsx",
    ],
  },
  {
    id: "bare <h1> on a page route",
    why: "A page's title is <PageHeader>; a bare <h1> forks the header's spacing and rule. docs/design-system.md §Page frame.",
    pattern: /<h1/,
    fileFilter: (relPath) => relPath.endsWith("/page.tsx"),
    allowed: [
      // Counted drift — swap for PageHeader, then delete.
      "settings/page.tsx",
    ],
  },
  {
    id: "dark: variants",
    why: "Dark mode is not supported in the dashboard; screens hardcode light warm values, so piecemeal dark: variants render half-converted UI. docs/design-system.md §The old look; docs/ui-conventions.md §What is deliberately not covered.",
    pattern: /\bdark:/,
    allowed: [
      "backup/backup-manager.tsx",
      "floor/session-panel.tsx",
      "ledger/fiscal-periods-section.tsx",
      "ui.tsx",
      "waiter/table-order-panel.tsx",
    ],
  },
  {
    id: "raw hex colours",
    why: "Hex classes are the old dialect's spelling of the tokens — they dodge restyles and drift from the palette. Write the stone/amber/emerald/destructive tokens instead (mapping table: docs/design-system.md §The old look). The whole dashboard is normalized — there is no baseline left to add to.",
    pattern: /[a-z]+-\[#(?:[0-9a-fA-F]{3,8})\]|(?:fill|stroke)="#[0-9a-fA-F]{3,8}"/,
    allowed: [],
  },
];

/** relPath (posix) of every non-test .ts/.tsx file under src/app/dashboard. */
function collectFiles(): string[] {
  const files: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry) || entry.includes(".test.")) continue;
      files.push(relative(DASHBOARD_DIR, full).split(sep).join("/"));
    }
  }
  walk(DASHBOARD_DIR);
  return files.sort();
}

interface Violation {
  relPath: string;
  line: number;
  matched: string;
}

function scan(rule: Rule, relPath: string, content: string): Violation[] {
  if (rule.fileFilter && !rule.fileFilter(relPath)) return [];
  const violations: Violation[] = [];
  for (const match of content.matchAll(new RegExp(rule.pattern.source, "g"))) {
    violations.push({
      relPath,
      line: content.slice(0, match.index).split("\n").length,
      matched: match[0],
    });
  }
  return violations;
}

function formatViolations(violations: Violation[]): string {
  return violations.map((v) => `  ${v.relPath}:${v.line}  ${v.matched}`).join("\n");
}

describe("design lint — docs/design-system.md banned patterns in src/app/dashboard", () => {
  const files = collectFiles();
  const contents = new Map(files.map((relPath) => [relPath, readFileSync(join(DASHBOARD_DIR, relPath), "utf8")]));

  it("scans a plausible number of files (guards against a broken walk)", () => {
    // The dashboard holds several hundred .ts/.tsx files; a walk that finds a
    // handful means the glob broke and every rule below would silently pass.
    expect(files.length).toBeGreaterThan(50);
  });

  for (const rule of RULES) {
    it(`bans ${rule.id}`, () => {
      const violations = files
        .filter((relPath) => !rule.allowed.includes(relPath))
        .flatMap((relPath) => scan(rule, relPath, contents.get(relPath)!));

      const detail = formatViolations(violations);
      expect(
        detail,
        [
          `Design-system violation: ${rule.id} in ${violations.length} place(s).`,
          `Why: ${rule.why}`,
          "Violations:",
          detail || "  (none)",
          "",
          "Fix the classes per docs/design-system.md — or, if the file already",
          "carried this pattern, add its path to the rule's baseline in",
          "src/app/dashboard/design-lint.test.ts.",
        ].join("\n"),
      ).toBe("");
    });
  }

  it("baseline is stale-free — fixed files must leave the allowlist", () => {
    const stale: string[] = [];
    for (const rule of RULES) {
      for (const relPath of rule.allowed) {
        // Primitives that define a pattern stay matched forever; drift entries
        // must keep matching, or they are done and only serve as noise.
        if (relPath === "page-chrome.tsx") continue;
        if (!contents.has(relPath)) {
          stale.push(`${rule.id}: ${relPath} (file no longer exists)`);
          continue;
        }
        if (scan(rule, relPath, contents.get(relPath)!).length === 0) {
          stale.push(`${rule.id}: ${relPath} (no longer violates)`);
        }
      }
    }

    expect(
      stale.join("\n"),
      [
        "Stale design-lint baseline entries — the file no longer violates:",
        stale.join("\n"),
        "",
        "Delete them from RULES in src/app/dashboard/design-lint.test.ts so the",
        "baseline keeps shrinking to zero.",
      ].join("\n"),
    ).toBe("");
  });
});
