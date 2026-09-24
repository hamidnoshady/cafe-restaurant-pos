"use client";

/**
 * The shape an app's main sidebar takes when the app is a flat list of
 * sections — written once, worn by every app that is one.
 *
 * CRM and Growth each shipped their own copy of this component, and the copies
 * were identical down to the comment about the two-line help text: the same
 * markup, the same «بازگشت» control, the same `line-clamp-2` description, the
 * same tooltip composition. Structural sameness was the *intent* there — "two
 * apps in the same platform whose menus behaved differently would be two
 * products" — but it was enforced by nobody, so the only thing keeping the two
 * menus in step was that no one had edited one of them yet. A fix to the
 * collapsed-rail behaviour, the tooltip, or the RTL arrow would have landed in
 * one app and quietly skipped the other.
 *
 * So the *arrangement* lives here and each app supplies only what is actually
 * its own: its sections, its labels and glyphs, its href function, its
 * active-state rule, and the name a screen reader announces the menu by. An
 * app whose menu is not a flat list (Website, with two collapsible managers;
 * Accounting, which arranges the business's own pages) keeps its own component
 * — this is the shared shape, not a mandate.
 *
 * The `NAV_LABEL_CLASS`/`APP_NAV_BUTTON_CLASS` skins and the «بازگشت» control
 * come from `sidebar-nav-styles.ts`, the same place every other menu in the
 * product takes them from, so «you are here» looks the same everywhere.
 */

import Link from "next/link";
import { ArrowRightIcon, type LucideIcon } from "lucide-react";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  APP_NAV_BUTTON_CLASS,
  BACK_TO_WORKSPACE_BUTTON_CLASS,
  NAV_LABEL_CLASS,
} from "./sidebar-nav-styles";

/** A section as a flat app menu needs it drawn. */
export interface AppSectionNavItem<K extends string = string> {
  key: K;
  label: string;
  /** One line under the label — hidden when the rail collapses to icons. */
  description: string;
  icon: LucideIcon;
}

/**
 * «بازگشت» leads out to the workspace home for every app, so owning the
 * sidebar never means trapping the member inside the app. One home, one label,
 * stated once rather than in each app's component.
 */
export const BACK_TO_WORKSPACE_HREF = "/dashboard";
export const BACK_TO_WORKSPACE_LABEL = "بازگشت به میز کار";

/** The «بازگشت» control: always first, always drawn as a control, not a section. */
export function BackToWorkspaceMenu({ onNavigate }: { onNavigate: () => void }) {
  return (
    <>
      <SidebarMenu className="space-y-1.5">
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip={BACK_TO_WORKSPACE_LABEL}
            className={BACK_TO_WORKSPACE_BUTTON_CLASS}
          >
            <Link href={BACK_TO_WORKSPACE_HREF} onClick={onNavigate}>
              {/* An arrow drawn for LTR points the wrong way in Persian. */}
              <ArrowRightIcon aria-hidden="true" className="size-5 shrink-0 rtl:rotate-180" />
              <span className={NAV_LABEL_CLASS}>{BACK_TO_WORKSPACE_LABEL}</span>
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <div aria-hidden="true" className="border-t border-border/80" />
    </>
  );
}

export function AppSectionNav<K extends string>({
  /** Names the menu for a screen reader — «بخش‌های …». */
  ariaLabel,
  /** The app's name and one line of description, from the shell registry. */
  title,
  description,
  items,
  hrefFor,
  isActive,
  onNavigate,
}: {
  ariaLabel: string;
  title: string;
  description: string;
  items: readonly AppSectionNavItem<K>[];
  hrefFor: (key: K) => string;
  isActive: (key: K) => boolean;
  onNavigate: () => void;
}) {
  return (
    <SidebarContent className="px-3 py-4">
      <nav aria-label={ariaLabel} className="space-y-3">
        <div className="px-2 group-data-[state=collapsed]/sidebar:hidden">
          <p className="text-sm font-bold text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-5 text-muted-foreground">{description}</p>
        </div>

        <BackToWorkspaceMenu onNavigate={onNavigate} />

        <SidebarMenu className="space-y-1.5">
          {items.map((item) => {
            const active = isActive(item.key);
            const Icon = item.icon;
            return (
              <SidebarMenuItem key={item.key}>
                <SidebarMenuButton
                  asChild
                  isActive={active}
                  tooltip={`${item.label} — ${item.description}`}
                  className={APP_NAV_BUTTON_CLASS}
                >
                  <Link
                    href={hrefFor(item.key)}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                  >
                    <Icon aria-hidden="true" className="size-5 shrink-0" />
                    <span className="min-w-0 flex-1 py-1.5 text-start group-data-[state=collapsed]/sidebar:hidden">
                      <span className="block truncate">{item.label}</span>
                      {/*
                        The help line is a second line, so it needs room to be
                        one: `truncate` cut «چرخهٔ حیات و خرید — با افزودن و
                        ویرایش» to about three words in a 16rem rail. Two lines,
                        clamped, and the full text in the row's tooltip.
                      */}
                      <span className="mt-0.5 block line-clamp-2 text-[11px] font-normal leading-4 text-muted-foreground">
                        {item.description}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </nav>
    </SidebarContent>
  );
}
