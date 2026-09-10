/**
 * The CRM app's main-menu entries (Phase 36).
 *
 * One list, two readers: the app's own sidebar (`crm-app-nav.tsx`, rendered in
 * the dashboard's app slot) and the overview's quick actions. Section *routes*
 * and the role gate stay in `crm-routes.ts` — this file adds only what a menu
 * needs to be drawn, so the app's name for a section and the section's own
 * heading cannot drift apart, and a cashier's shorter list is derived from
 * `canViewCrmSection` rather than being repeated here.
 *
 * No `"use client"` and no JSX: the list is data, and both a client component
 * and a server component need it.
 */

import {
  ContactIcon,
  CopyCheckIcon,
  HeadsetIcon,
  LayoutDashboardIcon,
  ListChecksIcon,
  ShieldCheckIcon,
  TargetIcon,
  UserSearchIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { canViewCrmSection, type CrmSectionKey } from "./crm-routes";

export interface CrmNavItem {
  key: CrmSectionKey;
  label: string;
  /** One line under the label — hidden in a collapsed sidebar. */
  description: string;
  icon: LucideIcon;
}

/** The app's sections, in menu order. The overview is the app's home. */
export const CRM_NAV_ITEMS: readonly CrmNavItem[] = [
  {
    key: "overview",
    label: "میز کار ارتباط با مشتری",
    description: "اعداد کلیدی و کارهای امروز",
    icon: LayoutDashboardIcon,
  },
  {
    key: "directory",
    label: "اشخاص",
    description: "جست‌وجو، افزودن و ویرایش",
    icon: UsersIcon,
  },
  {
    key: "persons",
    label: "پروندهٔ شخص",
    description: "تاریخچهٔ کامل یک مشتری",
    icon: ContactIcon,
  },
  {
    key: "segments",
    label: "بخش‌بندی",
    description: "گروه‌های پویا بر پایهٔ رفتار خرید",
    icon: UserSearchIcon,
  },
  {
    key: "deals",
    label: "قیف فروش",
    description: "معامله‌ها از سرنخ تا نتیجه",
    icon: TargetIcon,
  },
  {
    key: "activities",
    label: "کارها و پیگیری‌ها",
    description: "تماس، جلسه و یادآوری",
    icon: ListChecksIcon,
  },
  {
    key: "cases",
    label: "تیکت‌های خدمات",
    description: "شکایت‌ها و درخواست‌ها",
    icon: HeadsetIcon,
  },
  {
    key: "duplicates",
    label: "اشخاص تکراری",
    description: "یافتن و ادغام پرونده‌های دوتایی",
    icon: CopyCheckIcon,
  },
  {
    key: "consent",
    label: "رضایت ارتباط",
    description: "سابقهٔ اجازهٔ پیامک و ایمیل",
    icon: ShieldCheckIcon,
  },
];

/**
 * The entries a role may open — `canViewCrmSection` is the only gate, so a
 * section that becomes floor-safe changes the menu by changing that one
 * function rather than this list.
 */
export function crmNavItemsForRole(role: string | null | undefined): CrmNavItem[] {
  return CRM_NAV_ITEMS.filter((item) => canViewCrmSection(role ?? "", item.key));
}
