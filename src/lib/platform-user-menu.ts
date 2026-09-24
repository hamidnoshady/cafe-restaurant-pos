/**
 * What the sidebar's owner-name menu contains.
 *
 * The menu is the platform's utility drawer: the things that belong to the
 * *person and the platform* rather than to whichever app they happen to have
 * open — business settings, technical connections, billing, media, knowledge,
 * support, reporting a bug, and the way out. Every app has its own settings
 * page now, so keeping this list explicit is what stops an app's concern from
 * drifting into it (and stops «تنظیمات پلتفرم» from drifting into an app).
 *
 * Framework-free on purpose: the component that draws it is a client component
 * full of portals and focus management, and none of that needs to be mounted
 * to assert that the menu still points at `/settings`, still offers the bug
 * report as an *action* rather than a route, and still sends a PIN-role member
 * back to the staff door when they sign out.
 */

import {
  PLATFORM_SETTINGS_HOME,
  PLATFORM_SUBSCRIPTION_HREF,
  WORKSPACE_TOP_HREFS,
} from "./app-routes";

/**
 * An entry is either a link or one of two actions. `bug-report` is deliberately
 * not a route: reporting a bug opens the dialog the `BugReportProvider` owns,
 * which captures the page the member is standing on — navigating away to a form
 * would throw that context away.
 */
export type PlatformUserMenuItem =
  | { key: string; label: string; kind: "link"; href: string }
  | { key: string; label: string; kind: "bug-report" }
  | { key: string; label: string; kind: "logout"; returnTo: string }
  /**
   * Audit fix — "Switch account": signs out exactly like `logout`, but
   * always lands on the staff door's login-type chooser (never straight back
   * into a remembered door), and forgets this browser's remembered login
   * type so the chooser is shown again. Distinct from `logout` because a
   * member who wants to hand the terminal to someone signing in a *different
   * way* (an owner stepping aside for a cashier, or vice versa) should not
   * have to also clear their browser's storage by hand to see the chooser.
   */
  | { key: string; label: string; kind: "switch-account" };

/** Roles that sign in with a PIN (`team.ts`'s PIN_ROLES) — they return to the staff door. */
const PIN_ROLES = ["cashier", "waiter", "kitchen"];

/** Where signing out lands: the staff quick login, or the owner/manager door. */
export function logoutReturnTo(role: string): string {
  return PIN_ROLES.includes(role) ? "/login" : "/admin";
}

export function platformUserMenuItems(role: string): PlatformUserMenuItem[] {
  return [
    {
      key: "platform-settings",
      label: "تنظیمات پلتفرم",
      kind: "link",
      // The platform's settings, never an app's. Each app's own settings live
      // in the app's menu (`/accounting/settings`, `/growth/settings`, …).
      href: PLATFORM_SETTINGS_HOME,
    },
    { key: "connections", label: "اتصال‌های فنی", kind: "link", href: "/settings/connections" },
    { key: "billing", label: "اشتراک و پرداخت‌ها", kind: "link", href: PLATFORM_SUBSCRIPTION_HREF },
    { key: "media", label: "کتابخانهٔ رسانه", kind: "link", href: WORKSPACE_TOP_HREFS.media },
    { key: "knowledge", label: "پایگاه دانش", kind: "link", href: WORKSPACE_TOP_HREFS.knowledge },
    { key: "support", label: "پشتیبانی", kind: "link", href: WORKSPACE_TOP_HREFS.support },
    { key: "profile", label: "حساب کاربری", kind: "link", href: "/settings/profile" },
    { key: "bug-report", label: "گزارش مشکل", kind: "bug-report" },
    { key: "switch-account", label: "تعویض حساب", kind: "switch-account" },
    { key: "logout", label: "خروج", kind: "logout", returnTo: logoutReturnTo(role) },
  ];
}
