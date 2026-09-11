"use client";

/**
 * Phase 15 — the console shell.
 *
 * A client layout that bootstraps from `/api/platform/auth/me`: no session
 * bounces to `/platform/login`; a session renders dark-first, theme-aware
 * chrome, the sidebar, and — crucially — provides every child page the admin's capability list via
 * `CapabilityContext`, so pages hide controls the operator could not use. The
 * server still re-checks every write; this only keeps the UI honest.
 *
 * The login route is exempt: it has no session by definition, so this shell
 * renders its children bare (the login page paints its own full-screen card).
 *
 * The business workspace expands the same way, dynamically: while a business
 * page is open, its own sections are nested under «کسب‌وکارها» so the operator
 * never loses the context of which tenant they are inside.
 */
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { PlatformCapability } from "@/lib/platform-admin";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import { ThemeToggle } from "@/components/theme-toggle";
import { api, CapabilityContext, Button, PlatformPageSkeleton } from "./ui";
import { businessSections } from "./businesses/[id]/sections";

interface Me {
  admin: { id: string; fullName: string; email: string; role: PlatformAdminRole } | null;
  capabilities?: PlatformCapability[];
}

interface NavItem {
  label: string;
  href: string;
  cap?: PlatformCapability;
  exact?: boolean;
  /** Extra prefixes that keep this item active (e.g. a tenant workspace). */
  alsoActive?: string[];
  /** Sub-pages of this section, rendered nested while the section is open. */
  children?: { label: string; href: string; exact?: boolean }[];
}

const NAV: NavItem[] = [
  { label: "کسب‌وکارها", href: "/platform", exact: true, alsoActive: ["/platform/businesses"] },
  // Platform billing: Zarinpal config, credit packages, plan builder and the
  // payments ledger. Read surfaces are visible to any admin; the pages hide
  // their own write controls from operators without `billing.manage`.
  { label: "پرداخت‌ها", href: "/platform/billing" },
  // Phase 37b — provider credentials and credits are platform-owned, so they
  // belong beside billing rather than on any individual business profile.
  { label: "پیام‌رسانی", href: "/platform/messaging" },
  { label: "پلن‌ساز", href: "/platform/plans" },
  // Migration 0128 — the deployment-wide app switchboard («به‌زودی»، «در حال
  // تعمیر»، …). Readable by any admin; the page hides its own write controls
  // from an operator without `features.write`, the same way the flags panel does.
  { label: "برنامه‌ها", href: "/platform/apps" },
  { label: "رویدادها", href: "/platform/audit" },
  { label: "گزارش‌های خطا", href: "/platform/bug-reports", cap: "audit.read" },
  // Migration 0130 — the support desk: every business's support tickets,
  // answered from the console. Every admin role holds `support.manage`.
  { label: "پشتیبانی", href: "/platform/support", cap: "support.manage" },
  // Migration 0132 — the whole-system backup and the peer address that can pull
  // it. Visible to every role (a support operator answering «کپی دیشب هست؟» needs
  // to read the health line); the page hides every control the operator's role
  // cannot use, and the routes re-check each one.
  { label: "پشتیبان‌گیری", href: "/platform/backup", cap: "system.read" },
  {
    label: "سیستم",
    href: "/platform/system",
    children: [
      { label: "سلامت", href: "/platform/system", exact: true },
      { label: "پایش", href: "/platform/system/logs" },
    ],
  },
  // Migration 0139 — the website platform (eshobe-cms) administered from here:
  // the fleet report, every site's lifecycle, content sync in both directions and
  // its own log tail. Visible to every admin because the report is not privileged
  // information; each page hides the controls an operator without `cms.manage`
  // could not use, and every route re-checks it.
  {
    label: "سایت‌ساز",
    href: "/platform/cms",
    children: [
      { label: "میز فرمان", href: "/platform/cms", exact: true },
      { label: "سایت‌ها", href: "/platform/cms/sites" },
      { label: "همگام‌سازی", href: "/platform/cms/sync" },
      { label: "پایش", href: "/platform/cms/logs" },
      { label: "اتصال", href: "/platform/cms/connection" },
    ],
  },
  {
    label: "هوش مصنوعی",
    href: "/platform/ai",
    cap: "ai.read",
  },
  { label: "به‌روزرسانی‌ها", href: "/platform/updates" },
  { label: "پایگاه دانش", href: "/platform/knowledge" },
  // Phase 24 Wave 2 — the 2FA enrolment readout and the Kavenegar connection.
  // `system.read` rather than an owner-only capability: knowing that the
  // platform's 2FA deadline is three days away is not privileged information,
  // and the page hides its own write controls from anyone who lacks them.
  { label: "امنیت", href: "/platform/security", cap: "system.read" },
  { label: "مدیران", href: "/platform/admins", cap: "admins.manage" },
];

/** The business a `/platform/businesses/{id}/…` URL points at, for the sidebar. */
function businessIdFromPath(path: string): string | null {
  const m = path.match(/^\/platform\/businesses\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { setTheme } = useTheme();
  const isLogin = pathname === "/platform/login";

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  // Context for the «کسب‌وکارها» sub-menu: which business is open, and its name.
  const openBusinessId = isLogin ? null : businessIdFromPath(pathname);
  const [openBusiness, setOpenBusiness] = useState<{ id: string; name: string } | null>(null);

  // The console keeps its distinct dark-first identity until an operator picks
  // a theme. `ThemeToggle` writes this same next-themes key, so an explicit
  // light (or dark) choice always wins and survives future visits.
  useEffect(() => {
    if (!window.localStorage.getItem("theme")) setTheme("dark");
  }, [setTheme]);

  useEffect(() => {
    if (isLogin) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await api<Me>("/api/platform/auth/me");
      if (cancelled) return;
      if (!data.admin) {
        router.replace("/platform/login");
        return;
      }
      setMe(data);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLogin, pathname, router]);

  useEffect(() => {
    if (!openBusinessId) {
      setOpenBusiness(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { ok, data } = await api<{ business?: { name?: string } }>(
        `/api/platform/businesses/${openBusinessId}`,
      );
      if (cancelled) return;
      // A soft failure here only costs the sidebar its label — the page
      // itself renders its own errors — so a deleted business just collapses
      // the sub-menu instead of doubling the error surface.
      setOpenBusiness(ok && data.business?.name ? { id: openBusinessId, name: data.business.name } : null);
    })();
    return () => {
      cancelled = true;
    };
  }, [openBusinessId]);

  // The login page renders inside this layout but outside its chrome.
  if (isLogin) {
    return (
      <div className="relative min-h-screen bg-background" dir="rtl">
        <div className="absolute start-4 top-4 z-10">
          <ThemeToggle />
        </div>
        {children}
      </div>
    );
  }

  if (loading || !me?.admin) {
    return <PlatformPageSkeleton fullScreen />;
  }

  const caps = me.capabilities ?? [];

  async function logout() {
    await api("/api/platform/auth/logout", { method: "POST" });
    router.replace("/platform/login");
    router.refresh();
  }

  function active(item: { href: string; exact?: boolean; alsoActive?: string[] }): boolean {
    if (item.alsoActive?.some((prefix) => pathname.startsWith(prefix))) return true;
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  const sections =
    openBusinessId && openBusiness?.id === openBusinessId
      ? businessSections(openBusinessId, caps)
      : null;

  const sidebarLinks = (
    <>
      {NAV.filter((n) => !n.cap || caps.includes(n.cap)).map((n) => {
        const isActive = active(n);
        const showChildren = isActive && n.children;
        return (
          <div key={n.href} className="space-y-0.5">
            <Link
              href={n.href}
              aria-current={isActive ? "page" : undefined}
              className={
                isActive
                  ? "block rounded-lg bg-sky-500/15 px-3 py-2.5 text-sm font-medium text-sky-700 dark:text-sky-300"
                  : "block rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              }
            >
              {n.label}
            </Link>
            {showChildren ? (
              <div className="space-y-0.5 border-e border-border pe-0 ps-[1.35rem]">
                {n.children!.map((c) => {
                  const cActive =
                    c.exact ? pathname === c.href : pathname === c.href || pathname.startsWith(`${c.href}/`);
                  return (
                    <Link
                      key={c.href}
                      href={c.href}
                      aria-current={cActive ? "page" : undefined}
                      className={
                        cActive
                          ? "block rounded-lg bg-muted px-2.5 py-1.5 text-[13px] font-medium text-foreground"
                          : "block rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      }
                    >
                      {c.label}
                    </Link>
                  );
                })}
              </div>
            ) : null}
            {n.href === "/platform" && sections ? (
              <div className="space-y-0.5 rounded-lg border border-border bg-muted p-1.5">
                <p className="truncate px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {openBusiness?.name}
                </p>
                {sections.map((s) => {
                  const sActive = pathname === s.href;
                  return (
                    <Link
                      key={s.href}
                      href={s.href}
                      aria-current={sActive ? "page" : undefined}
                      className={
                        sActive
                          ? "block rounded-lg bg-sky-500/15 px-2.5 py-1.5 text-[13px] font-medium text-sky-700 dark:text-sky-300"
                          : "block rounded-lg px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      }
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
    </>
  );

  return (
    <CapabilityContext.Provider value={caps}>
      <div className="flex min-h-screen bg-background text-foreground" dir="rtl">
        <aside className="hidden w-60 shrink-0 flex-col border-e border-border bg-card md:flex">
          <div className="border-b border-border p-4">
            <p className="text-xs font-medium uppercase tracking-widest text-sky-600/80 dark:text-sky-400/80">
              Platform
            </p>
            <p className="mt-1 font-bold">کنسول مدیریت سکو</p>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto p-3">{sidebarLinks}</nav>
          <div className="border-t border-border p-4 text-sm">
            <p className="truncate font-semibold">{me.admin.fullName}</p>
            <p className="mb-3 truncate text-xs text-muted-foreground">
              {PLATFORM_ROLE_LABELS[me.admin.role] ?? me.admin.role}
            </p>
            <div className="flex items-center justify-between gap-2">
              <Button variant="ghost" onClick={logout}>
                خروج
              </Button>
              <ThemeToggle />
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-w-0 items-center justify-between gap-2 border-b border-border px-3 py-3 sm:px-4 md:hidden">
            <p className="min-w-0 truncate font-bold">کنسول سکو</p>
            <div className="flex shrink-0 items-center gap-1">
              <ThemeToggle />
              <Button variant="ghost" onClick={logout}>
                خروج
              </Button>
            </div>
          </header>
          {/* Mobile nav strip */}
          <nav className="flex min-w-0 gap-1 overflow-x-auto border-b border-border px-2 py-2 md:hidden">
            {NAV.filter((n) => !n.cap || caps.includes(n.cap)).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={
                  active(n)
                    ? "shrink-0 whitespace-nowrap rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-700 dark:text-sky-300"
                    : "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-muted-foreground"
                }
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <main className="flex-1 overflow-y-auto p-3 sm:p-4 md:p-8">{children}</main>
        </div>
      </div>
    </CapabilityContext.Provider>
  );
}
