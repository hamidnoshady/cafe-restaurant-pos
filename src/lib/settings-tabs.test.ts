import { describe, expect, it } from "vitest";
import { INDUSTRIES } from "./industries";
import { PERMISSIONS } from "./permissions";
import { SETTINGS_TABS, visibleSettingsTabs } from "./settings-tabs";

describe("visibleSettingsTabs", () => {
  it("does not return unavailable settings sections", () => {
    expect(visibleSettingsTabs([PERMISSIONS.accountsEdit]).map((tab) => tab.key)).toEqual(["accounts"]);
  });

  it("returns administration sections for settings managers", () => {
    expect(visibleSettingsTabs([PERMISSIONS.settingsManage]).map((tab) => tab.key)).toEqual([
      "business",
      "tax",
      "pricing",
      "online-platforms",
      "payment-methods",
      "menu",
      "printers",
      "devices",
    ]);
  });

  it("shows team management, shift history, the audit trail, and the security center together, gated on team.manage (Phase 20 Waves 5-7)", () => {
    expect(visibleSettingsTabs([PERMISSIONS.teamManage]).map((tab) => tab.key)).toEqual([
      "team",
      "shifts",
      "audit-log",
      "security-center",
    ]);
  });

  it("returns tabs that can cross the server/client boundary", () => {
    // /dashboard/settings is a server component handing these straight to
    // <SettingsManager>, a client one. React refuses to serialize a function
    // prop ("Functions cannot be passed directly to Client Components"), and it
    // refuses at render time — a 500 on the page, with nothing to catch it at
    // build time or in a type check. `industryText` is the only function a tab
    // carries, and both of the paths through the resolver used to let it
    // through: the tab whose rewrite returns {} was passed along untouched, and
    // the tab whose rewrite returns a description was spread, function and all.
    const everyPermission = Object.values(PERMISSIONS);
    for (const industry of INDUSTRIES) {
      const tabs = visibleSettingsTabs(everyPermission, {
        role: "owner",
        features: Object.fromEntries(SETTINGS_TABS.flatMap((tab) => [
          ...(tab.feature ? [[tab.feature, true]] : []),
          ...(tab.requiredAnyFeature ?? []).map((flag) => [flag, true]),
        ])),
        industry,
      });
      expect(tabs.length).toBeGreaterThan(0);
      for (const tab of tabs) {
        expect(JSON.parse(JSON.stringify(tab))).toEqual(tab);
        for (const [key, value] of Object.entries(tab)) {
          expect(`${industry}.${tab.key}.${key}: ${typeof value}`).not.toContain("function");
        }
      }
    }
  });

  it("rewrites wording per industry without the callback surviving", () => {
    const foodService = visibleSettingsTabs([PERMISSIONS.settingsManage], { industry: "food_service" });
    const jewelry = visibleSettingsTabs([PERMISSIONS.settingsManage], { industry: "jewelry" });

    // The tab whose rewrite returns {} for F&B — the "unchanged" path.
    expect(foodService.find((tab) => tab.key === "tax")?.description).toBe("نرخ پیش‌فرض و نرخ هر دسته از منو");
    expect(jewelry.find((tab) => tab.key === "tax")?.description).toBe("نرخ پیش‌فرض مالیات بر ارزش افزوده");

    // The tab whose rewrite always returns a description — the "spread" path.
    expect(foodService.find((tab) => tab.key === "pricing")?.description).not.toBe(
      jewelry.find((tab) => tab.key === "pricing")?.description,
    );

    // A caller with no industry still gets the F&B defaults, and still no callback.
    const noIndustry = visibleSettingsTabs([PERMISSIONS.settingsManage]);
    expect(noIndustry.find((tab) => tab.key === "tax")?.description).toBe("نرخ پیش‌فرض و نرخ هر دسته از منو");
    expect(noIndustry.every((tab) => !("industryText" in tab))).toBe(true);
  });

  it("preserves the former role and feature gates for operational settings", () => {
    expect(
      visibleSettingsTabs([], {
        role: "manager",
        features: { backup: true, offline_mode: true },
      }).map((tab) => tab.key),
    ).toEqual(["backup"]);

    expect(
      visibleSettingsTabs([], {
        role: "owner",
        features: { backup: true, offline_mode: true },
      }).map((tab) => tab.key),
    ).toEqual(["branch-management", "server-sync", "backup"]);

    expect(
      visibleSettingsTabs([], {
        role: "owner",
        features: { backup: false, offline_mode: false },
      }),
    ).toEqual([]);

    expect(
      visibleSettingsTabs([], {
        role: "owner",
        features: { backup: false, offline_mode: false, multi_location: true },
      }).map((tab) => tab.key),
    ).toEqual(["branch-management"]);
  });
});
