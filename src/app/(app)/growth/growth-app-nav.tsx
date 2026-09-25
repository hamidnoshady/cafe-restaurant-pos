"use client";

/**
 * The Growth app's own main sidebar (Phase 36b, revised again).
 *
 * Rendered in the dashboard's app slot for every route under `/growth` —
 * `src/lib/app-shells.ts` is the rule that hands the slot over. Three things
 * change for the app there:
 *
 * - its sections are the *main* menu, at the level the business's own pages sit
 *   at, instead of a second menu drawn inside the page (a sub-menu of a page,
 *   which read as one folder of accounting);
 * - nothing from حسابداری or the rest of the business is listed, because the
 *   app is a separate product, not a corner of the ledger — the way the
 *   business's flat nav no longer lists «رشد و بازاریابی» either, so each menu
 *   has one answer to "where am I";
 * - «میز کار» is the way out, so owning a sidebar does not mean trapping the
 *   member in it.
 *
 * The entries come from `growth-nav.ts` and are filtered by the app's own role
 * gate, so a cashier's sidebar holds the one section they may open — exactly
 * what the page redirects already assume. The arrangement is `AppSectionNav`,
 * shared with CRM, so the two apps' menus cannot drift apart.
 */

import type { AppShellNavProps } from "@/app/dashboard/app-shell-nav";
import { AppSectionNav } from "@/app/dashboard/app-section-nav";
import { growthNavItemsForPermissions } from "./growth-nav";
import {
  growthSectionHref,
  isGrowthSectionPathname,
  type GrowthSectionKey,
} from "./growth-routes";

export function GrowthAppNav({ shell, permissions, pathname, onNavigate }: AppShellNavProps) {
  return (
    <AppSectionNav<GrowthSectionKey>
      ariaLabel="بخش‌های رشد و بازاریابی"
      title={shell.label}
      description={shell.description}
      items={growthNavItemsForPermissions(new Set(permissions as import("@/lib/permissions").Permission[]))}
      hrefFor={growthSectionHref}
      isActive={(key) => isGrowthSectionPathname(pathname, key)}
      onNavigate={onNavigate}
    />
  );
}
