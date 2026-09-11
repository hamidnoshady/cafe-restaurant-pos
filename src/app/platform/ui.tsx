"use client";

/**
 * Phase 15 — shared client helpers for the super-admin console.
 *
 * A deliberately small, self-contained kit that mirrors the tenant dashboard's
 * `ui.tsx` but lives apart, because the console is a separate realm with its
 * own error vocabulary and its own visual identity (a darker chrome, so an
 * operator never mistakes it for a tenant screen). Persian RTL throughout.
 */
import { createContext, useContext } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PlatformCapability } from "@/lib/platform-admin";
import { toPersianDigits } from "@/lib/digits";

export async function api<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = {} as T;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Persian messages for the console's error codes. */
export function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    unauthorized: "وارد نشده‌اید.",
    forbidden: "این عملیات در سطح دسترسی شما نیست.",
    bad_request: "درخواست نامعتبر بود.",
    invalid_credentials: "ایمیل یا رمز عبور نادرست است.",
    missing_credentials: "ایمیل و رمز عبور را وارد کنید.",
    missing_fields: "فیلدهای الزامی را پر کنید.",
    invalid_email: "ایمیل معتبر نیست.",
    weak_password: "رمز عبور باید حداقل ۸ نویسه باشد.",
    email_password_mismatch: "این ایمیل قبلاً ثبت شده و رمز عبور واردشده با آن هم‌خوانی ندارد.",
    invalid_status: "وضعیت نامعتبر است.",
    not_found: "پیدا نشد.",
    nothing_to_change: "تغییری برای ذخیره وجود ندارد.",
    business_archived: "کسب‌وکار بایگانی‌شده قابل ورود نیست.",
    business_not_found: "کسب‌وکار پیدا نشد.",
    no_owner: "این کسب‌وکار مالک فعالی برای ورود ندارد.",
    impersonation_read_only: "این نشست فقط‌خواندنی است و امکان تغییر ندارد.",
    invalid_plan: "این پلن در فهرست پلن‌ها وجود ندارد.",
    invalid_timezone: "منطقهٔ زمانی معتبر نیست.",
    reset_confirmation_required: "برای ریست، عبارت تأیید را دقیق وارد کنید.",
    reset_not_possible: "ریست ممکن نیست؛ این کسب‌وکار مالک فعال و قابل ورود ندارد.",
    reset_failed: "ریست انجام نشد و هیچ داده‌ای تغییر نکرد. دوباره تلاش کنید.",
    delete_confirmation_required: "برای حذف، عبارت تأیید را دقیق وارد کنید.",
    delete_failed: "حذف انجام نشد و هیچ داده‌ای تغییر نکرد. دوباره تلاش کنید.",
    no_location: "این کسب‌وکار هنوز شعبه‌ای ندارد؛ ابتدا یک شعبه بسازید.",
    code_not_found: "کد اتصال پیدا نشد.",
    code_expired: "این کد منقضی شده است.",
    code_already_redeemed: "این کد قبلاً استفاده شده است.",
    code_revoked: "این کد لغو شده است.",
    // Phase 23 Wave 3 — per-business subdomains
    invalid_subdomain:
      "زیردامنه باید بین ۳ تا ۶۳ نویسه و فقط شامل حروف انگلیسی کوچک، رقم و خط تیره باشد؛ " +
      "نباید با خط تیره شروع یا تمام شود.",
    reserved_subdomain: "این زیردامنه رزرو شده است و قابل استفاده نیست.",
    missing_subdomain: "زیردامنهٔ کسب‌وکار را به انگلیسی وارد کنید.",
    subdomain_taken: "این زیردامنه قبلاً به کسب‌وکار دیگری اختصاص یافته است.",
    invalid_industry: "نوع کسب‌وکار نامعتبر است.",
    industry_not_available: "این نوع کسب‌وکار هنوز در دسترس نیست.",
    unchanged: "زیردامنه تغییری نکرده است.",
    // OpenObserve (پایش)
    observability_not_configured: "پایش هنوز تنظیم نشده است؛ متغیرهای OPENOBSERVE را در سرور وارد کنید.",
    observability_unreachable: "سرویس پایش در دسترس نیست. آخرین داده‌های موفق نمایش داده می‌شود.",
    invalid_level: "سطح لاگ نامعتبر است.",
    // App availability (migration 0128) — «به‌زودی»، «در حال تعمیر» و…
    invalid_app_state: "وضعیت برنامه نامعتبر است.",
    // Knowledge base content (migration 0131)
    invalid_slug: "نامک باید حروف کوچک انگلیسی، رقم و خط تیره باشد (مثل pos-basics).",
    missing_title: "عنوان را وارد کنید.",
    missing_label: "نام برچسب را وارد کنید.",
    slug_taken: "این نامک قبلاً استفاده شده است.",
    category_has_children: "این دسته زیردسته دارد؛ اول زیردسته‌ها را منتقل یا حذف کنید.",
    category_has_articles: "این دسته راهنما دارد؛ اول راهنماها را به دستهٔ دیگری منتقل کنید.",
    category_cycle: "دستهٔ والد نامعتبر است.",
    parent_not_found: "دستهٔ والد پیدا نشد.",
    invalid_video_url: "آدرس ویدیو باید با http:// یا https:// شروع شود.",
    // Migration 0132 — the whole-system backup and the peer restore by address.
    // The page's own `text()` covers the long backup vocabulary; these are the
    // shapes that can also arrive through a generic console error path.
    backup_failed: "پشتیبان‌گیری کامل سیستم ناموفق بود.",
    backup_busy: "یک پشتیبان‌گیری دیگر همین حالا در حال اجراست.",
    restore_busy: "یک بازگردانی دیگر در حال اجراست؛ کمی بعد دوباره تلاش کنید.",
    confirmation_required: "برای بازگردانی کامل، عبارت تأیید را دقیق وارد کنید.",
    passphrase_required: "عبارت عبور رمزنگاری لازم است؛ آن را وارد کنید.",
    checksum_mismatch: "فایل دانلودشده با نسخهٔ اعلام‌شده هم‌خوانی ندارد؛ بازگردانی متوقف شد.",
    newer_schema: "آن پشتیبان از نسخهٔ جدیدتری گرفته شده و این سرور هنوز آن مهاجرت‌ها را ندارد.",
    newer_postgres: "نسخهٔ PostgreSQL سرور مقابل جدیدتر است و با pg_restore این سرور بازگردانی نمی‌شود.",
    https_required: "آدرس باید https باشد، یا «اجازهٔ اتصال ناامن» را در تنظیمات روشن کنید.",
    peer_unreachable: "سرور مقابل در دسترس نیست.",
    peer_auth_failed: "کلید این سرور در آن سمت پذیرفته نشد (لغو یا منقضی شده است؟).",
    bad_manifest: "پاسخ سرور مقابل معتبر نیست.",
    invalid_cover_url: "آدرس تصویر باید با http:// یا https:// شروع شود.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

/** The signed-in admin's capabilities, provided by the layout to every page. */
export const CapabilityContext = createContext<PlatformCapability[]>([]);

export function useCapabilities(): PlatformCapability[] {
  return useContext(CapabilityContext);
}

export function useCan(): (cap: PlatformCapability) => boolean {
  const caps = useCapabilities();
  return (cap) => caps.includes(cap);
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
      {children}
    </div>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-4 rounded-lg border border-primary/30 bg-primary/10 px-4 py-3 text-sm text-primary">
      {children}
    </div>
  );
}

export const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-border bg-transparent px-3 py-1 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="mb-4 block">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  disabled,
  variant = "primary",
  className,
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "submit" | "button";
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost";
  className?: string;
  title?: string;
}) {
  const styles = {
    primary: "bg-primary text-primary-foreground hover:bg-primary/80",
    danger: "bg-destructive text-primary-foreground hover:bg-destructive/80",
    ghost: "border border-border text-foreground hover:bg-muted",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** A labelled status pill for the three business lifecycle states. */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "فعال", cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30" },
    suspended: { label: "معلق", cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30" },
    archived: { label: "بایگانی", cls: "bg-card/10 text-card-foreground border-border/20" },
  };
  const s = map[status] ?? { label: status, cls: "bg-card/10 text-card-foreground border-border/20" };
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function Card({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
      {title ? <h2 className="mb-4 text-sm font-semibold text-card-foreground">{title}</h2> : null}
      {children}
    </div>
  );
}

/**
 * Plan keys come from the `plans` catalogue (migration 0034) and are English;
 * the console always shows the Persian name. Unknown keys — a plan retired
 * from the catalogue — fall back to the raw key rather than rendering blank.
 */
export const PLAN_LABELS: Record<string, string> = {
  free: "رایگان",
  pro: "حرفه‌ای",
  business: "سازمانی",
};

export function planLabel(key: string, names?: Record<string, string> | null): string {
  return names?.[key] ?? PLAN_LABELS[key] ?? key;
}

export function PlanBadge({ plan, names }: { plan: string; names?: Record<string, string> | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-400/25 bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-800 dark:text-indigo-200">
      {planLabel(plan, names)}
      <span className="text-[10px] text-indigo-800/40 dark:text-indigo-200/40" dir="ltr">
        {plan}
      </span>
    </span>
  );
}

/** The styled-native look the filter toolbars use; keeps RTL in either theme. */
export const selectClass =
  "h-10 w-full min-w-0 cursor-pointer rounded-lg border border-border bg-transparent px-3 text-sm text-foreground outline-none transition-colors hover:border-border/25 focus:border-ring/60 focus:ring-2 focus:ring-ring/20 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

/**
 * A sub-navigation strip shared by every section of the console that has
 * sub-pages (AI, and inside a business). Rendered as tabs under the section
 * header on all viewports — horizontal scrolling keeps it usable on phones.
 */
export function SubNav({
  items,
}: {
  items: { label: string; href: string; exact?: boolean }[];
}) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="بخش‌های این صفحه"
      className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1"
    >
      {items.map((item) => {
        const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "shrink-0 whitespace-nowrap rounded-lg bg-sky-500/15 px-3.5 py-2 text-sm font-medium text-sky-700 dark:text-sky-300"
                : "shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Placeholder rows while a list loads, so a page never flashes empty. */
export function SkeletonRows({
  rows = 4,
  label = "در حال بارگذاری اطلاعات",
  className,
}: {
  rows?: number;
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      className={`space-y-2 ${className ?? ""}`}
    >
      <div aria-hidden="true" className="space-y-2">
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            className="h-12 animate-pulse rounded-xl border border-border bg-card motion-reduce:animate-none"
            style={{ animationDelay: `${i * 90}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

/** Page-shaped fallback for navigation and the console's initial auth check. */
export function PlatformPageSkeleton({ fullScreen = false }: { fullScreen?: boolean }) {
  return (
    <div
      className={fullScreen ? "min-h-screen bg-background p-4 sm:p-8" : "min-w-0"}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="در حال بارگذاری صفحه مدیریت"
    >
      <div className="mx-auto w-full max-w-6xl" aria-hidden="true">
        <div className="mb-6 flex items-start justify-between gap-4 border-b border-border pb-5">
          <div className="min-w-0 flex-1 space-y-3">
            <div className="h-7 w-48 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
            <div className="h-3.5 w-[30rem] max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
          <div className="h-9 w-24 shrink-0 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />
        </div>
        <div className="mb-5 grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="space-y-3 rounded-xl border border-border bg-card p-4">
              <div className="h-3 w-20 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <div className="h-7 w-24 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-card p-4 sm:p-5">
          <SkeletonRows rows={6} />
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint ? <p className="max-w-sm text-xs leading-6 text-muted-foreground">{hint}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

/** A headline figure for the dashboards (businesses list, system page). */
export function StatCard({
  label,
  value,
  tone = "neutral",
  hint,
  icon,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "bad";
  hint?: string;
  icon?: React.ReactNode;
}) {
  const toneCls = {
    neutral: "border-border text-foreground",
    ok: "border-emerald-500/25 text-emerald-700 dark:text-emerald-300",
    warn: "border-amber-500/25 text-amber-700 dark:text-amber-300",
    bad: "border-red-500/25 text-red-700 dark:text-red-300",
  }[tone];
  return (
    <div className={`rounded-xl border bg-card p-4 ${toneCls}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">{label}</p>
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className="mt-1 text-2xl font-bold tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-5 text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Persian-digit date+time for every page; `dateOnly` drops the clock. */
export function fmtDate(iso: string | null | undefined, dateOnly = false): string {
  if (!iso) return "—";
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", {
        dateStyle: "medium",
        ...(dateOnly ? {} : { timeStyle: "short" as const }),
      }).format(new Date(iso)),
    );
  } catch {
    return iso;
  }
}
