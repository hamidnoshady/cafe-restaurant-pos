import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The rules «تنظیمات حسابداری» has to keep.
 *
 * Like `accounting-nav-rtl.test.ts` beside it, this suite greps the sources:
 * the repo's vitest runs in Node with no jsdom and no `@testing-library`, and
 * `vitest.config.ts` only collects `src/**\/*.test.ts`, so a client component
 * cannot be mounted here. Grepping is weaker than rendering, but it pins the
 * exact regressions this screen has already had — a settings page that was
 * four static cards, a placeholder promising settings it never showed, a
 * duplicated shortcut component, and an arrow rotated the wrong way in RTL.
 */

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

/**
 * Comments explain the very mistakes these tests forbid, so a naive grep over
 * the raw file matches the prose describing a bug and fails on a correct file.
 * Every assertion below is about code, so strip comments first.
 */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const SETTINGS_SOURCE = code(read("./settings-section.tsx"));
const PANEL_SOURCE = code(read("../../../components/app-settings/app-settings-panel.tsx"));
const SHORTCUT_SOURCE = code(read("../../../components/app-settings/app-settings-shortcut.tsx"));
const ROUTE_SOURCE = code(read("../../api/ledger/settings/route.ts"));

/** Physical-direction utilities, which mirror wrongly under `dir="rtl"`. */
const PHYSICAL_CLASSES =
  /(?<![\w-])(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-[\w./[\]]+/g;
const PHYSICAL_BARE = /(?<![\w-])(?:text-left|text-right)(?![\w-])/g;

function physicalClassesIn(source: string): string[] {
  return [...(source.match(PHYSICAL_CLASSES) ?? []), ...(source.match(PHYSICAL_BARE) ?? [])];
}

describe("the accounting settings page reports real configuration", () => {
  it("reads the ledger's own settings endpoint", () => {
    // The regression: four hard-coded cards that could not say what the VAT
    // rate was, whether a fiscal year existed, or how big the chart was.
    expect(SETTINGS_SOURCE).toMatch(/\/api\/ledger\/settings/);
  });

  it("states the VAT rate, the chart size and the fiscal-period state", () => {
    expect(SETTINGS_SOURCE).toMatch(/vatRate/);
    expect(SETTINGS_SOURCE).toMatch(/accounts\.total/);
    expect(SETTINGS_SOURCE).toMatch(/fiscal\.openPeriods/);
    expect(SETTINGS_SOURCE).toMatch(/fiscal\.lockedPeriods/);
  });

  it("names the automatic posting rules instead of promising them later", () => {
    expect(SETTINGS_SOURCE).toMatch(/postingRules/);
    // The placeholder these replaced must not come back on this page.
    expect(SETTINGS_SOURCE).not.toMatch(/comingSoon/);
    expect(SETTINGS_SOURCE).not.toMatch(/به‌زودی/);
  });

  it("distinguishes «not configured» from a configured zero", () => {
    // A null VAT rate and a 0% VAT rate are different facts, and an
    // accountant has to be able to tell them apart.
    expect(SETTINGS_SOURCE).toMatch(/vatRate === null/);
    expect(SETTINGS_SOURCE).toMatch(/تعریف نشده/);
  });

  it("warns when no fiscal year exists, because that blocks closing a period", () => {
    expect(SETTINGS_SOURCE).toMatch(/yearCount === 0/);
    expect(SETTINGS_SOURCE).toMatch(/هنوز هیچ سال مالی تعریف نشده است/);
  });
});

describe("the page survives a failed or pending read", () => {
  it("offers a retry rather than an endless skeleton", () => {
    // The bug this prevents: `if (!data) return <Skeleton/>` with no error
    // branch, which leaves a failed fetch indistinguishable from a slow one.
    expect(SETTINGS_SOURCE).toMatch(/SecondaryButton/);
    expect(SETTINGS_SOURCE).toMatch(/تلاش دوباره/);
    expect(SETTINGS_SOURCE).toMatch(/ErrorBox/);
  });

  it("shows a content-shaped skeleton while loading", () => {
    expect(SETTINGS_SOURCE).toMatch(/SectionCardSkeleton/);
  });
});

describe("the settings page is written for RTL and for a phone", () => {
  it("uses logical insets, never physical left/right ones", () => {
    expect(physicalClassesIn(SETTINGS_SOURCE)).toEqual([]);
    expect(physicalClassesIn(PANEL_SOURCE)).toEqual([]);
    expect(physicalClassesIn(SHORTCUT_SOURCE)).toEqual([]);
  });

  it("mirrors the «leaves this app» arrow anticlockwise, not clockwise", () => {
    // ↗ rotated +90° is ↘ — an arrow pointing down into the card it labels.
    // The correct mirror of ↗ in RTL is ↖, which is a -90° turn.
    expect(PANEL_SOURCE).toMatch(/rtl:-rotate-90/);
    expect(PANEL_SOURCE).not.toMatch(/(?<!-)rtl:rotate-90/);
  });

  it("does not flip the «open this page» arrow, which already points to the inline end", () => {
    // `ArrowLeftIcon` + `rtl:rotate-180` pointed every shortcut backwards: in
    // a Persian document the inline end — "forward" — is the left.
    expect(SHORTCUT_SOURCE).toMatch(/ArrowLeftIcon/);
    expect(SHORTCUT_SOURCE).not.toMatch(/rtl:rotate-180/);
  });

  it("gives the shortcut a full-width tap target on a phone", () => {
    expect(SHORTCUT_SOURCE).toMatch(/w-full/);
    expect(SHORTCUT_SOURCE).toMatch(/sm:w-auto/);
    // At least the 44px the design system asks of a touch target.
    expect(SHORTCUT_SOURCE).toMatch(/min-h-11/);
  });

  it("stacks the multi-column fact grids instead of forcing columns on a phone", () => {
    // `grid-cols-4` with no breakpoint is how a 360px screen ends up with four
    // unreadable columns of Persian text.
    const unbreakpointed = SETTINGS_SOURCE.match(/(?<![:\w-])grid-cols-[2-9]/g) ?? [];
    expect(unbreakpointed).toEqual([]);
  });

  it("tells a screen reader that a platform link leaves the app", () => {
    // The arrow carrying that meaning is `aria-hidden`, so without this the
    // fact was visible only to sighted users.
    expect(PANEL_SOURCE).toMatch(/className="sr-only">\(در تنظیمات پلتفرم باز می‌شود\)</);
  });
});

describe("the settings route", () => {
  it("draws the app's own door — owner, manager, accountant", () => {
    expect(ROUTE_SOURCE).toContain("requirePermission(PERMISSIONS.ledgerView)");
  });

  it("runs inside the tenant scope", () => {
    expect(ROUTE_SOURCE).toMatch(/withTenantScope/);
  });

  it("scopes every read to the signed-in business", () => {
    // A settings read that forgets `business_id` reports another tenant's
    // chart. RLS is the backstop; the predicate is the intent.
    const selects = ROUTE_SOURCE.match(/FROM (accounts|fiscal_years|fiscal_periods|businesses)[\s\S]{0,200}?`/g) ?? [];
    expect(selects.length).toBeGreaterThan(0);
    for (const select of selects) expect(select).toMatch(/business_id = \$1|id = \$1/);
  });

  it("reports the fiscal year that contains today, not merely the newest", () => {
    // A business that defined next year in advance would otherwise be shown
    // periods nobody is posting into.
    expect(ROUTE_SOURCE).toMatch(/current_date BETWEEN starts_on AND ends_on/);
  });
});

describe("the app settings shortcut has exactly one definition", () => {
  it("is the shared component, not a per-app copy", () => {
    // Accounting, the CRM and the website manager each had a byte-identical
    // `settings-shortcuts.tsx`. Three copies meant three places to forget the
    // arrow fix above.
    for (const app of ["accounting", "crm", "websites"]) {
      expect(() => read(`../${app}/settings-shortcuts.tsx`)).toThrow();
    }
  });
});
