"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MenuIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/theme-toggle";
import { LogoutButton } from "./logout-button";

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

export interface NavItem {
  label: string;
  href?: string;
  roles?: string[];
}

interface SidebarProps {
  navItems: NavItem[];
  role: string;
  fullName: string;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The scrollable list of nav links. Shared between the desktop rail and the mobile drawer. */
function NavLinks({
  navItems,
  role,
  pathname,
  onNavigate,
}: {
  navItems: NavItem[];
  role: string;
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 space-y-1 overflow-y-auto p-3">
      {navItems.map((item) => {
        const allowed = !item.roles || item.roles.includes(role);
        if (item.href && allowed) {
          const active = isActive(pathname, item.href);
          return (
            <Link
              key={item.label}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "block rounded-lg px-3 py-3 text-sm transition-colors md:py-2.5",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-primary/10 hover:text-primary",
              )}
            >
              {item.label}
            </Link>
          );
        }
        return (
          <span
            key={item.label}
            className="block cursor-default rounded-lg px-3 py-3 text-sm text-muted-foreground/50 md:py-2.5"
          >
            {item.label}
          </span>
        );
      })}
    </nav>
  );
}

/** Header shown inside both the desktop rail and the mobile drawer. */
function SidebarBrand({ withThemeToggle = true }: { withThemeToggle?: boolean }) {
  return (
    <div className="flex items-start justify-between border-b p-4">
      <div>
        <p className="font-bold">کافه و رستوران</p>
        <p className="text-xs text-muted-foreground">نسخهٔ آزمایشی</p>
      </div>
      {withThemeToggle ? <ThemeToggle /> : null}
    </div>
  );
}

function SidebarFooter({ role, fullName }: { role: string; fullName: string }) {
  return (
    <div className="border-t p-4 text-sm">
      <p className="font-semibold">{fullName}</p>
      <p className="mb-3 text-xs text-muted-foreground">{ROLE_LABELS[role] ?? role}</p>
      <LogoutButton />
    </div>
  );
}

export function DashboardSidebar({ navItems, role, fullName }: SidebarProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <>
      {/* Mobile top bar — visible below md; holds the drawer trigger */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-2 border-b bg-card px-3 py-2 md:hidden">
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="باز کردن منو">
              <MenuIcon />
            </Button>
          </SheetTrigger>
          <SheetContent side="right" showCloseButton={false} className="w-72 p-0">
            <div className="flex h-full flex-col">
              <SidebarBrand withThemeToggle={false} />
              <NavLinks
                navItems={navItems}
                role={role}
                pathname={pathname}
                onNavigate={() => setOpen(false)}
              />
              <SidebarFooter role={role} fullName={fullName} />
            </div>
          </SheetContent>
        </Sheet>
        <div className="min-w-0 text-center">
          <p className="truncate font-bold leading-tight">کافه و رستوران</p>
        </div>
        <ThemeToggle />
      </header>

      {/* Desktop rail — hidden below md */}
      <aside className="hidden w-56 shrink-0 flex-col border-e bg-card md:flex">
        <SidebarBrand />
        <NavLinks navItems={navItems} role={role} pathname={pathname} />
        <SidebarFooter role={role} fullName={fullName} />
      </aside>
    </>
  );
}
