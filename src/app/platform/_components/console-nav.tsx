"use client";

/**
 * The console's grouped navigation, rendered from `NAV_GROUPS`. Shared by the
 * desktop sidebar and the mobile drawer so the two never drift. A business
 * workspace, when open, injects its own contextual section list under the
 * «کسب‌وکارها» item (task section 2 + 7).
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { PlatformCapability } from "@/lib/platform-admin";
import { NAV_GROUPS, navItemActive, navItemVisible } from "../_lib/navigation";
import type { BusinessSection } from "../businesses/[id]/sections";

export function ConsoleNav({
  caps,
  onNavigate,
  workspace,
}: {
  caps: PlatformCapability[];
  /** Called when a link is followed — closes the mobile drawer. */
  onNavigate?: () => void;
  /** The open business workspace, to nest its sections under «کسب‌وکارها». */
  workspace?: { name: string; sections: BusinessSection[] } | null;
}) {
  const pathname = usePathname();

  return (
    <nav className="space-y-4" aria-label="ناوبری کنسول">
      {NAV_GROUPS.map((group, gi) => {
        const items = group.items.filter((item) => navItemVisible(item, caps));
        if (items.length === 0) return null;
        return (
          <div key={group.label ?? `group-${gi}`} className="space-y-1">
            {group.label ? (
              <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                {group.label}
              </p>
            ) : null}
            {items.map((item) => {
              const active = navItemActive(item, pathname);
              const showWorkspace =
                item.href === "/platform/businesses" && active && workspace;
              return (
                <div key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "block rounded-lg px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </Link>
                  {showWorkspace ? (
                    <div className="mt-1 space-y-0.5 rounded-lg border border-border bg-muted/40 p-1.5">
                      <p className="truncate px-2 pt-1 text-[11px] font-medium text-muted-foreground">
                        {workspace!.name}
                      </p>
                      {workspace!.sections.map((s) => {
                        const sActive = pathname === s.href;
                        return (
                          <Link
                            key={s.href}
                            href={s.href}
                            onClick={onNavigate}
                            aria-current={sActive ? "page" : undefined}
                            className={cn(
                              "block rounded-lg px-2.5 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              sActive
                                ? "bg-primary/10 font-medium text-primary"
                                : "text-muted-foreground hover:bg-muted hover:text-foreground",
                            )}
                          >
                            {s.label}
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
    </nav>
  );
}
