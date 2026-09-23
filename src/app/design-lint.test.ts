/**
 * The design-system lint for every tenant-facing realm *outside* the dashboard.
 *
 * The dashboard test (`src/app/dashboard/design-lint.test.ts`) holds the line
 * where the language lives. This test holds the same line where a business
 * first meets the product: the login card, the first-run welcome wizard, the
 * setup wizard, the invite and consent screens, the apex business directory,
 * and the shared `src/components` layer they are built from. Before this test
 * those realms spoke the previous dialect — `shadow-sm` cards, spinner
 * loaders, light-only colours, hand-rolled skins — so opening the app as a
 * jewellery or haberdashery business looked like a different product from the
 * accounting suite two screens later. Dark mode IS supported across the app:
 * colours come from the theme tokens (which flip) plus paired `dark:` shades,
 * so a hardcoded light colour with no token/no `dark:` counterpart is what
 * must not drift back.
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
  /** Colour rules for dark mode: a light class on a line with a `dark:` counterpart is fine. */
  darkMode?: boolean;
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
    id: "light-only warm neutrals (dark mode)",
    why: "Dark mode is supported: stone-* neutrals must use the theme tokens (bg-card, text-foreground, border-border, muted, …) which flip automatically. A residual hardcoded stone-*/solid bg-white with no token/dark: counterpart renders a light chip on a dark surface. QR-code images are allowed to stay bg-white for scannability.",
    pattern:
      /(?:(?:[a-z-]+:)*!?)(?:bg|text|border|ring|divide|from|to|via|decoration|caret)-stone-\d{2,3}|\bbg-white\b(?!\/)/,
    darkMode: true,
  },
  {
    id: "light-only accent/status colours (dark mode)",
    why: "Dark mode is supported: amber (brand) and emerald/rose/red/sky status colours need a light-on-dark shade. A hardcoded colour class with no dark: counterpart is unreadable in dark mode. Pair it with a dark: shade.",
    pattern:
      /(?:(?:[a-z-]+:)*!?)(?:text|bg|border|ring|divide)-(?:amber|emerald|rose|red|sky)-(?:50|100|200|300|400|500|600|700|800|900|950)(?![\w/-])/,
    darkMode: true,
  },
  {
    id: "spinner loading",
    why: "Loading is a skeleton (FormLoadingSkeleton/Skeleton for regions) and a busy label («در حال ورود…») for actions — never animate-spin. docs/design-system.md §Charts and loading.",
    pattern: /animate-spin/,
  },
  {
    id: "restated card skin",
    why: "The card skin lives in cardClass; restating `rounded-2xl border … bg-card … shadow-[…]` forks it. Compose cardClass (import from @/app/dashboard/page-chrome). docs/design-system.md §Page frame.",
    pattern: /rounded-2xl border border-border\/80 bg-card|rounded-2xl bg-card|border border-input bg-card/,
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
  {
    id: "gradient backgrounds",
    why: "Desktop UI audit: pages use a solid canvas (bg-background) plus cardClass surfaces, never a decorative gradient wash. A bg-gradient-*/from-*-to-* glow reads as a marketing landing page, not the desktop application shell, and drifts between screens depending on who added it last.",
    pattern: /\bbg-gradient-(?:to|radial|conic)-|(?<![\w-])from-[a-z]+-\d{2,3}\/?\d*\b/,
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
        if (rule.darkMode) {
          const lines = content.split("\n");
          // The PLATFORM_MFA_THEME block in mfa-step.tsx styles the always-dark
          // platform console login (white/sky-on-slate); its colours are meant
          // for a dark surface in both themes, so exclude that block.
          const platformBlock =
            relPath === "components/auth/mfa-step.tsx"
              ? (() => {
                  const start = content.indexOf("PLATFORM_MFA_THEME");
                  const end = content.indexOf("\n};", start);
                  return { start, end };
                })()
              : null;
          const offsetOf = (idx: number) => content.slice(0, idx).split("\n").length - 1;
          lines.forEach((line, i) => {
            if (platformBlock && i >= offsetOf(platformBlock.start) && i <= offsetOf(platformBlock.end)) return;
            for (const match of line.matchAll(new RegExp(rule.pattern.source, "g"))) {
              // A line already carrying a dark: counterpart flips correctly.
              if (line.includes("dark:")) continue;
              // QR-code images keep bg-white in both themes for scannability.
              if (/bg-white/.test(match[0])) {
                const nearby = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
                if (/totpQr|QR|qrCode/.test(nearby)) continue;
              }
              violations.push(`  ${relPath}:${i + 1}  ${match[0]}`);
            }
          });
          continue;
        }
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
