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
      "pricing",
      "menu",
      "printers",
    ]);
  });
});
