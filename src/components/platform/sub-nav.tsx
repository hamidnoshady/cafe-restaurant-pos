"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * A route-backed tab strip for sections with sub-pages (a business workspace,
 * CMS, AI, billing…). Horizontal-scrolls on phones so a long strip stays
 * usable, and marks the active tab via the pathname. Distinct from the central
 * <Tabs>, which is for in-page (non-routed) tabbing.
 */
export interface SubNavItem {
  label: string;
  href: string;
  exact?: boolean;
}

export function PlatformSubNav({
  items,
  ariaLabel = "بخش‌های این صفحه",
  className,
}: {
  items: SubNavItem[];
  ariaLabel?: string;
  className?: string;
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        "mb-5 flex gap-1 overflow-x-auto rounded-xl bg-card p-1 ring-1 ring-foreground/10",
        className,
      )}
    >
      {items.map((item) => {
        const active = item.exact
          ? pathname === item.href
          : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-primary/10 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
