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
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { PlatformCapability } from "@/lib/platform-admin";
import { PLATFORM_ROLE_LABELS, type PlatformAdminRole } from "@/lib/platform-admin";
import { api, CapabilityContext, Button } from "./ui";

interface Me {
  admin: { id: string; fullName: string; email: string; role: PlatformAdminRole } | null;
  capabilities?: PlatformCapability[];
}

interface NavItem {
  label: string;
  href: string;
  cap?: PlatformCapability;
  exact?: boolean;
}

const NAV: NavItem[] = [
  { label: "کسب‌وکارها", href: "/platform", exact: true },
  { label: "رویدادها", href: "/platform/audit" },
  { label: "سیستم", href: "/platform/system" },
  { label: "مدیران", href: "/platform/admins", cap: "admins.manage" },
];

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname === "/platform/login";

  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

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

  function active(item: NavItem): boolean {
    if (item.exact) return pathname === item.href;
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

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
          <nav className="flex-1 space-y-1 overflow-y-auto p-3">
            {NAV.filter((n) => !n.cap || caps.includes(n.cap)).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active(n) ? "page" : undefined}
                className={
                  active(n)
                    ? "block rounded-lg bg-sky-500/15 px-3 py-2.5 text-sm font-medium text-sky-300"
                    : "block rounded-lg px-3 py-2.5 text-sm text-white/60 transition-colors hover:bg-white/5 hover:text-white"
                }
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="border-t border-white/10 p-4 text-sm">
            <p className="font-semibold">{me.admin.fullName}</p>
            <p className="mb-3 text-xs text-white/40">
              {PLATFORM_ROLE_LABELS[me.admin.role] ?? me.admin.role}
            </p>
            <Button variant="ghost" onClick={logout}>
              خروج
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center justify-between gap-2 border-b border-white/10 px-4 py-3 md:hidden">
            <p className="font-bold">کنسول سکو</p>
            <Button variant="ghost" onClick={logout}>
              خروج
            </Button>
          </header>
          {/* Mobile nav strip */}
          <nav className="flex gap-1 overflow-x-auto border-b border-white/10 px-2 py-2 md:hidden">
            {NAV.filter((n) => !n.cap || caps.includes(n.cap)).map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={
                  active(n)
                    ? "whitespace-nowrap rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-300"
                    : "whitespace-nowrap rounded-lg px-3 py-1.5 text-sm text-white/60"
                }
              >
                {n.label}
              </Link>
            ))}
          </nav>
          <main className="flex-1 overflow-y-auto p-4 md:p-8">{children}</main>
        </div>
      </div>
    </CapabilityContext.Provider>
  );
}
