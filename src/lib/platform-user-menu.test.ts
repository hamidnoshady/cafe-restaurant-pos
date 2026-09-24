import { describe, expect, it } from "vitest";
import { APP_SETTINGS_HREFS, PLATFORM_SETTINGS_HOME } from "./app-routes";
import { logoutReturnTo, platformUserMenuItems } from "./platform-user-menu";

describe("the sidebar's identity menu", () => {
  it("offers the platform utilities the member expects, in order", () => {
    expect(platformUserMenuItems("owner").map((item) => item.key)).toEqual([
      "platform-settings",
      "connections",
      "billing",
      "media",
      "knowledge",
      "support",
      "profile",
      "bug-report",
      "switch-account",
      "logout",
    ]);
  });

  it("points «تنظیمات پلتفرم» at the platform settings, never at an app's", () => {
    const item = platformUserMenuItems("owner").find((entry) => entry.key === "platform-settings");
    expect(item).toEqual({
      key: "platform-settings",
      label: "تنظیمات پلتفرم",
      kind: "link",
      href: PLATFORM_SETTINGS_HOME,
    });
    const appSettings = new Set(Object.values(APP_SETTINGS_HREFS));
    for (const entry of platformUserMenuItems("owner")) {
      if (entry.kind === "link") expect(appSettings.has(entry.href)).toBe(false);
    }
  });

  it("keeps every link a real, absolute in-app path", () => {
    for (const entry of platformUserMenuItems("manager")) {
      if (entry.kind !== "link") continue;
      expect(entry.href.startsWith("/")).toBe(true);
      expect(entry.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("keeps «گزارش مشکل» an action rather than a route", () => {
    // The report captures the page the member is standing on, so it opens the
    // provider's dialog; navigating to a form would throw that context away.
    const item = platformUserMenuItems("cashier").find((entry) => entry.key === "bug-report");
    expect(item?.kind).toBe("bug-report");
    expect(item).not.toHaveProperty("href");
  });

  it("returns a member to the door they sign back in through", () => {
    // PIN roles use the staff quick login; owner/manager use the password door.
    expect(logoutReturnTo("cashier")).toBe("/login");
    expect(logoutReturnTo("waiter")).toBe("/login");
    expect(logoutReturnTo("kitchen")).toBe("/login");
    expect(logoutReturnTo("owner")).toBe("/admin");
    expect(logoutReturnTo("manager")).toBe("/admin");
    expect(logoutReturnTo("accountant")).toBe("/admin");

    const logout = platformUserMenuItems("cashier").at(-1);
    expect(logout).toEqual({ key: "logout", label: "خروج", kind: "logout", returnTo: "/login" });
  });

  it("offers «تعویض حساب» as a distinct action from a plain logout", () => {
    const item = platformUserMenuItems("owner").find((entry) => entry.key === "switch-account");
    expect(item).toEqual({ key: "switch-account", label: "تعویض حساب", kind: "switch-account" });
  });
});
