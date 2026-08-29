"use client";

/**
 * Phase 15 — the console shell.
 *
 * A client layout that bootstraps from `/api/platform/auth/me`: no session
 * bounces to `/platform/login`; a session renders the dark chrome, the sidebar,
 * and — crucially — provides every child page the admin's capability list via
 * `CapabilityContext`, so pages hide controls the operator could not use. The
 * server still re-checks every write; this only keeps the UI honest.
 *
 * The login route is exempt: it has no session by definition, so this shell
 * renders its children bare (the login page paints its own full-screen card).
 *
 * Sections with sub-pages (AI) declare `children` and expand in place while
 * active. The business workspace expands the same way, dynamically: while a
 * business page is open, its own sections are nested under «کسب‌وکارها» so the
 * operator never loses the context of which tenant they are inside.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { PlatformCapability } from "@/lib/platform-admin";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import { api, CapabilityContext, Button } from "./ui";
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
  { label: "رویدادها", href: "/platform/audit" },
  {
    label: "سیستم",
    href: "/platform/system",
    children: [
      { label: "سلامت", href: "/platform/system", exact: true },
      { label: "پایش", href: "/platform/system/logs" },
    ],
  },
  {
    label: "هوش مصنوعی",
    href: "/platform/ai",
    cap: "ai.read",
    children: [
      { label: "تنظیمات و اشتراک‌ها", href: "/platform/ai", exact: true },
      { label: "پرامپت‌ها", href: "/platform/ai/prompts" },
    ],
  },
  { label: "به‌روزرسانی‌ها", href: "/platform/updates" },
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
  const isLogin = pathname === "/platform/login";

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  // Context for the «کسب‌وکارها» sub-menu: which business is open, and its name.
  const openBusinessId = isLogin ? null : businessIdFromPath(pathname);
  const [openBusiness, setOpenBusiness] = useState<{ id: string; name: string } | null>(null);

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
    return <div className="min-h-screen bg-slate-950">{children}</div>;
  }

  if (loading || !me?.admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 text-sm text-white/50">
        در حال بارگذاری…
      </div>
    );
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
                  ? "block rounded-lg bg-sky-500/15 px-3 py-2.5 text-sm font-medium text-sky-300"
                  : "block rounded-lg px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white"
              }
            >
              {n.label}
            </Link>
            {showChildren ? (
              <div className="space-y-0.5 border-e border-white/10 pe-0 ps-[1.35rem]">
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
                          ? "block rounded-md bg-white/10 px-2.5 py-1.5 text-[13px] font-medium text-white"
                          : "block rounded-md px-2.5 py-1.5 text-[13px] text-white/45 transition-colors hover:bg-white/5 hover:text-white/80"
                      }
                    >
                      {c.label}
                    </Link>
                  );
                })}
              </div>
            ) : null}
            {n.href === "/platform" && sections ? (
              <div className="space-y-0.5 rounded-lg border border-white/10 bg-black/20 p-1.5">
                <p className="truncate px-2 pt-1 text-[11px] font-medium uppercase tracking-wide text-white/35">
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
                          ? "block rounded-md bg-sky-500/15 px-2.5 py-1.5 text-[13px] font-medium text-sky-300"
                          : "block rounded-md px-2.5 py-1.5 text-[13px] text-white/50 transition-colors hover:bg-white/5 hover:text-white/85"
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
      <div className="flex min-h-screen bg-slate-950 text-white" dir="rtl">
        <aside className="hidden w-60 shrink-0 flex-col border-e border-white/10 bg-white/2 md:flex">
          <div className="border-b border-white/10 p-4">
            <p className="text-xs font-medium uppercase tracking-widest text-sky-400/80">
              Platform
            </p>
            <p className="mt-1 font-bold">کنسول مدیریت سکو</p>
          </div>
          <nav className="flex-1 space-y-1 overflow-y-auto p-3">{sidebarLinks}</nav>
          <div className="border-t border-white/10 p-4 text-sm">
            <p className="truncate font-semibold">{me.admin.fullName}</p>
            <p className="mb-3 truncate text-xs text-white/40">
              {PLATFORM_ROLE_LABELS[me.admin.role] ?? me.admin.role}
            </p>
            <Button variant="ghost" onClick={logout}>
              خروج
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex min-w-0 items-center justify-between gap-2 border-b border-white/10 px-3 py-3 sm:px-4 md:hidden">
            <p className="min-w-0 truncate font-bold">کنسول سکو</p>
            <Button variant="ghost" onClick={logout}>
              خروج
            </Button>
          </header>
          {/* Mobile nav strip */}
          <nav className="flex min-w-0 gap-1 overflow-x-auto border-b border-white/10 px-2 py-2 md:hidden">
            {NAV.filter((n) => !n.cap || caps.includes(n.cap)).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={
                  active(n)
                    ? "shrink-0 whitespace-nowrap rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-300"
                    : "shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-white/60"
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
