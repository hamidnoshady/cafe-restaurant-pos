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
import type { PlatformCapability } from "@/lib/platform-admin";

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
    <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
      {children}
    </div>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <div className="mb-4 rounded-lg border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-200">
      {children}
    </div>
  );
}

export const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-white/15 bg-white/5 px-3 py-1 text-sm text-white outline-none transition-colors placeholder:text-white/30 focus:border-sky-400/60 focus:ring-2 focus:ring-sky-400/20 disabled:opacity-50";

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
      <span className="mb-1 block text-sm font-medium text-white/80">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-white/40">{hint}</span> : null}
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
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: "submit" | "button";
  disabled?: boolean;
  variant?: "primary" | "danger" | "ghost";
  className?: string;
}) {
  const styles = {
    primary: "bg-sky-500 text-white hover:bg-sky-400",
    danger: "bg-red-600 text-white hover:bg-red-500",
    ghost: "border border-white/15 text-white/80 hover:bg-white/5",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-9 items-center justify-center rounded-lg px-4 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

/** A labelled status pill for the three business lifecycle states. */
export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    active: { label: "فعال", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
    suspended: { label: "معلق", cls: "bg-amber-500/15 text-amber-300 border-amber-500/30" },
    archived: { label: "بایگانی", cls: "bg-white/10 text-white/50 border-white/20" },
  };
  const s = map[status] ?? { label: status, cls: "bg-white/10 text-white/60 border-white/20" };
  return (
    <span className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

export function Card({ children, title }: { children: React.ReactNode; title?: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/3 p-4 sm:p-5">
      {title ? <h2 className="mb-4 text-sm font-semibold text-white/90">{title}</h2> : null}
      {children}
    </div>
  );
}
