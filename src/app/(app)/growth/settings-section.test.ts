import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The Growth settings home is intentionally a read-only status board with
 * one editor per engine. These source assertions protect it from regressing to
 * the old static «به‌زودی» cards or an endless skeleton on an unavailable API.
 */
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

const SETTINGS_SOURCE = code(read("./settings-section.tsx"));
const ROUTE_SOURCE = code(read("../../api/growth/settings/route.ts"));
const PANEL_SOURCE = code(read("../../../components/app-settings/app-settings-panel.tsx"));
const SHORTCUT_SOURCE = code(read("../../../components/app-settings/app-settings-shortcut.tsx"));

const PHYSICAL_CLASSES =
  /(?<![\w-])(?:ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|text-left|text-right)-[\w./[\]]+/g;
const PHYSICAL_BARE = /(?<![\w-])(?:text-left|text-right)(?![\w-])/g;

function physicalClassesIn(source: string): string[] {
  return [...(source.match(PHYSICAL_CLASSES) ?? []), ...(source.match(PHYSICAL_BARE) ?? [])];
}

describe("Growth settings", () => {
  it("reports live configuration instead of static coming-soon cards", () => {
    expect(SETTINGS_SOURCE).toMatch(/\/api\/growth\/settings/);
    expect(SETTINGS_SOURCE).toMatch(/defaultProgram/);
    expect(SETTINGS_SOURCE).toMatch(/pointValueRial/);
    expect(SETTINGS_SOURCE).toMatch(/امتیاز به‌ازای ۱۰۰٬۰۰۰/);
    expect(SETTINGS_SOURCE).not.toMatch(/امتیاز به‌ازای ۱۰٬۰۰۰/);
    expect(SETTINGS_SOURCE).toMatch(/campaigns\.live/);
    expect(SETTINGS_SOURCE).toMatch(/messaging\.configured/);
    expect(SETTINGS_SOURCE).toMatch(/commission\.activeRuleCount/);
    expect(SETTINGS_SOURCE).not.toMatch(/comingSoon/);
    expect(SETTINGS_SOURCE).not.toMatch(/به‌زودی/);
  });

  it("takes each setting to its one existing editor and identifies the CRM handoff", () => {
    for (const section of ["loyalty", "campaigns", "messaging", "commission"]) {
      expect(SETTINGS_SOURCE).toMatch(new RegExp(`growthSectionHref\\(\\"${section}\\"\\)`));
    }
    expect(SETTINGS_SOURCE).toMatch(/crmSectionHref\(\"consent"\)/);
    expect(SETTINGS_SOURCE).toMatch(/مدیریت رضایت ارتباط \(CRM\)/);
    expect(SETTINGS_SOURCE).toMatch(/AppSettingsShortcut/g);
  });

  it("shows a meaningful failed state with a retry and a content-shaped loading state", () => {
    expect(SETTINGS_SOURCE).toMatch(/ErrorBox/);
    expect(SETTINGS_SOURCE).toMatch(/SecondaryButton/);
    expect(SETTINGS_SOURCE).toMatch(/تلاش دوباره/);
    expect(SETTINGS_SOURCE).toMatch(/SectionCardSkeleton/);
  });

  it("keeps fact grids readable on a phone and uses logical direction utilities", () => {
    const unbreakpointed = SETTINGS_SOURCE.match(/(?<![:\w-])grid-cols-[2-9]/g) ?? [];
    expect(unbreakpointed).toEqual([]);
    expect(physicalClassesIn(SETTINGS_SOURCE)).toEqual([]);
    expect(physicalClassesIn(PANEL_SOURCE)).toEqual([]);
    expect(physicalClassesIn(SHORTCUT_SOURCE)).toEqual([]);
  });
});

describe("the Growth settings read route", () => {
  it("is tenant-scoped and management-only", () => {
    expect(ROUTE_SOURCE).toMatch(/withTenantScope/);
    expect(ROUTE_SOURCE).toMatch(/requireRole\(\"owner\", \"manager\"\)/);
  });

  it("reports the four engines from their own services", () => {
    expect(ROUTE_SOURCE).toMatch(/listPrograms/);
    expect(ROUTE_SOURCE).toMatch(/listPromotionCatalogue/);
    expect(ROUTE_SOURCE).toMatch(/listMessageTemplates/);
    expect(ROUTE_SOURCE).toMatch(/listCommissionRules/);
    expect(ROUTE_SOURCE).toMatch(/getPublicMessageConfig/);
  });
});
