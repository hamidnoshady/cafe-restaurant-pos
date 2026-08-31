/**
 * The design-system lint for every tenant-facing realm *outside* the dashboard.
 *
 * The dashboard test (`src/app/dashboard/design-lint.test.ts`) holds the line
 * where the language lives. This test holds the same line where a business
 * first meets the product: the login card, the first-run welcome wizard, the
 * setup wizard, the invite and consent screens, the apex business directory,
 * and the shared `src/components` layer they are built from. Before this test
 * those realms spoke the previous dialect — `shadow-sm` cards, spinner
 * loaders, `dark:` variants, hand-rolled skins — so opening the app as a
 * jewellery or haberdashery business looked like a different product from the
 * accounting suite two screens later.
 *
 * Not scanned:
 *  - `src/app/dashboard/**` — its own test covers it.
 *  - `src/app/platform/**` — the super-admin console is deliberately a
 *    separate visual identity (see its `ui.tsx` header: "a darker chrome, so
 *    an operator never mistakes it for a tenant screen").
 *  - `src/components/ui/**` — the shadcn layer; tokens/variants are changed
 *    there, never one-off classes at call sites.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = fileURLToPath(new URL("./", import.meta.url));
const REPO_DIR = join(APP_DIR, "..", "..");
const COMPONENTS_DIR = join(REPO_DIR, "src", "components");

interface Rule {
  id: string;
  why: string;
  pattern: RegExp;
}

const RULES: readonly Rule[] = [
  {
    id: "cool neutrals",
    why: "Neutrals are the warm stone scale; gray/slate/zinc/neutral read as a different product. Use stone-* or the tokens (docs/design-system.md §Colour roles).",
    pattern: /[a-z:-]-(?:gray|slate|zinc|neutral)-\d{2,3}/,
  },
  {
    id: "heavy shadows",
    why: "A card carries the one warm 1px shadow (compose cardClass from @/app/dashboard/page-chrome); hover lift and shadow-sm/md/lg are not in the language. docs/design-system.md §Weight.",
    pattern: /(?<![\w-])shadow-(?:sm|md|lg|xl|2xl)\b/,
  },
  {
    id: "dark: variants",
    why: "The product is light-only; dark: variants render half-converted UI. docs/design-system.md §The old look.",
    pattern: /\bdark:/,
  },
  {
    id: "spinner loading",
    why: "Loading is a skeleton (FormLoadingSkeleton/Skeleton for regions) and a busy label («در حال ورود…») for actions — never animate-spin. docs/design-system.md §Charts and loading.",
    pattern: /animate-spin/,
  },
  {
    id: "restated card skin",
    why: "The card skin lives in cardClass; restating `rounded-2xl border … bg-card … shadow-[…]` forks it. Compose cardClass (import from @/app/dashboard/page-chrome). docs/design-system.md §Page frame.",
    pattern: /rounded-2xl border border-stone-200\/80 bg-card|rounded-2xl bg-card|border border-input bg-card/,
  },
  {
    id: "raw hex colours",
    why: "Hex classes dodge the theme and drift from the palette; write the stone/amber/emerald/destructive tokens instead.",
    pattern: /[a-z]+-\[#(?:[0-9a-fA-F]{3,8})\]/,
  },
  {
    id: "bare loading copy",
    why: "A loading region reserves its shape with a skeleton and announces itself through the skeleton's aria-label, not a lone visible sentence. docs/design-system.md §Charts and loading.",
    pattern: /<(?:p|div|span)\b[^>]*>\s*در حال (?:بارگذاری|خواندن|جستجو|جست‌وجو|محاسبه)[^<{]*</,
  },
];

function walk(root: string, prefix: string): string[] {
  const files: string[] = [];
  if (statSync(root).isDirectory()) {
    for (const entry of readdirSync(root)) {
      const full = join(root, entry);
      if (statSync(full).isDirectory()) {
        files.push(...walk(full, `${prefix}${entry}/`));
        continue;
      }
      if (!/\.(?:ts|tsx)$/.test(entry) || entry.includes(".test.")) continue;
      files.push(`${prefix}${entry}`);
    }
  }
  return files;
}

/**
 * Tenant realms outside the dashboard: the entry surfaces under src/app plus
 * the shared component layer minus the shadcn primitives.
 */
function collectFiles(): { relPath: string; absPath: string }[] {
  const appFiles = walk(APP_DIR, "")
    .filter((rel) => !rel.startsWith("dashboard/"))
    .filter((rel) => !rel.startsWith("platform/"))
    .map((rel) => ({ relPath: rel, absPath: join(APP_DIR, rel.split(sep).join("/")) }));
  const componentFiles = walk(COMPONENTS_DIR, "components/")
    .filter((rel) => !rel.startsWith("components/ui/"))
    .map((rel) => ({ relPath: rel, absPath: join(REPO_DIR, "src", rel) }));
  return [...appFiles, ...componentFiles].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

describe("design lint — the same design system on every tenant-facing surface", () => {
  const files = collectFiles();
  const contents = new Map(files.map(({ relPath, absPath }) => [relPath, readFileSync(absPath, "utf8")]));

  it("scans a plausible number of files (guards against a broken walk)", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const rule of RULES) {
    it(`bans ${rule.id}`, () => {
      const violations: string[] = [];
      for (const { relPath } of files) {
        const content = contents.get(relPath)!;
        for (const match of content.matchAll(new RegExp(rule.pattern.source, "g"))) {
          violations.push(`  ${relPath}:${content.slice(0, match.index).split("\n").length}  ${match[0]}`);
        }
      }

      expect(
        violations.join("\n"),
        [
          `Design-system violation: ${rule.id} in ${violations.length} place(s).`,
          `Why: ${rule.why}`,
          "Violations:",
          violations.join("\n") || "  (none)",
          "",
          "Login, welcome, setup, invite, consent and the shared components",
          "speak the same language as the dashboard (docs/design-system.md).",
          "Fix the classes, or compose the primitive the rule names.",
        ].join("\n"),
      ).toBe("");
    });
  }
});
