"use client";

/**
 * The Growth app's own side menu (Phase 36b, revised).
 *
 * The app now lives at its own set of routes under `/dashboard/growth`, so its
 * sections get a real side menu — one entry per page — the way a standalone
 * product has. It is rendered inside the dashboard's global sidebar, so the
 * Growth app reads as its own area with its own navigation, not a folder inside
 * accounting. Active state is read from the path, and cashiers see only the
 * surface they are allowed to open (`loyalty`).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  CreditCardIcon,
  HandCoinsIcon,
  HeartIcon,
  MegaphoneIcon,
  TrendingUpIcon,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { cardClass } from "../page-chrome";
import { growthSectionHref, type GrowthSectionKey } from "./growth-routes";

interface NavItem {
  key: GrowthSectionKey;
  label: string;
  description: string;
  icon: LucideIcon;
  managerOnly: boolean;
}

const NAV_ITEMS: NavItem[] = [
  {
    key: "overview",
    label: "میز کار رشد",
    description: "اعداد کلیدی و رویدادها",
    icon: TrendingUpIcon,
    managerOnly: true,
  },
  {
    key: "campaigns",
    label: "کمپین‌ها",
    description: "موتور تخفیف و اثربخشی",
    icon: MegaphoneIcon,
    managerOnly: true,
  },
  {
    key: "gift-cards",
    label: "کارت هدیه",
    description: "صدور و مصرف",
    icon: CreditCardIcon,
    managerOnly: true,
  },
  {
    key: "loyalty",
    label: "وفاداری و اعتبار",
    description: "امتیاز و اعتبار فروشگاهی",
    icon: HeartIcon,
    managerOnly: false,
  },
  {
    key: "commission",
    label: "پورسانت فروشندگان",
    description: "قواعد و رتبه‌بندی",
    icon: HandCoinsIcon,
    managerOnly: true,
  },
];

export function GrowthSideNav({ role }: { role: string }) {
  const pathname = usePathname();
  const items = NAV_ITEMS.filter(
    (item) => !item.managerOnly || role === "owner" || role === "manager",
  );

  return (
    <nav
      aria-label="بخش‌های رشد و بازاریابی"
      className={cn("p-2 sm:p-3", cardClass)}
    >
      <p className="px-3 pb-2 pt-1 text-[11px] font-semibold tracking-wide text-stone-400">
        بخش‌های برنامه
      </p>
      <ul className="space-y-1">
        {items.map((item) => {
          const active =
            item.key === "overview"
              ? pathname === "/dashboard/growth"
              : pathname === `/dashboard/growth/${item.key}` ||
                pathname.startsWith(`/dashboard/growth/${item.key}/`);
          const Icon = item.icon;
          return (
            <li key={item.key}>
              <Link
                href={growthSectionHref(item.key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/40",
                  active
                    ? "bg-amber-100 font-semibold text-amber-950"
                    : "text-stone-600 hover:bg-stone-50 hover:text-stone-950",
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-[18px] shrink-0",
                    active ? "text-amber-800" : "text-stone-400",
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-right">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
