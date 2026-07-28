import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "./permissions";
import { visibleSettingsTabs } from "./settings-tabs";

describe("visibleSettingsTabs", () => {
  it("does not return unavailable settings sections", () => {
    expect(visibleSettingsTabs([PERMISSIONS.accountsEdit]).map((tab) => tab.key)).toEqual(["accounts"]);
  });

  it("returns administration sections for settings managers", () => {
    expect(visibleSettingsTabs([PERMISSIONS.settingsManage]).map((tab) => tab.key)).toEqual([
      "business",
      "tax",
      "menu",
      "printers",
    ]);
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
    ).toEqual(["branch-sync", "backup"]);

    expect(
      visibleSettingsTabs([], {
        role: "owner",
        features: { backup: false, offline_mode: false },
      }),
    ).toEqual([]);
  });
});
