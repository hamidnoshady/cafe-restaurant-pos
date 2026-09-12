"use client";

/** Small shared UI pieces for the wizard steps. */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { CircleAlertIcon, InfoIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { nextPath, prevPath, stepIndex, stepsFor, STEPS } from "./steps";
import type { WizardStep } from "@/lib/wizard-steps";
import { useSetupIndustry } from "./industry-context";

export async function api<T = Record<string, unknown>>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(url, {
    headers:
      init?.body instanceof FormData
        ? undefined
        : { "Content-Type": "application/json" },
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

/** Persian messages for the API's error codes. */
export function errorMessage(
  code: string | undefined,
  messages?: string[],
): string {
  if (messages?.length) return messages.join(" ");
  const map: Record<string, string> = {
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی فقط برای مالک و مدیر است.",
    bad_request: "درخواست نامعتبر بود.",
    missing_fields: "فیلدهای الزامی را پر کنید.",
    invalid_email: "ایمیل معتبر نیست.",
    weak_password: "گذرواژه باید حداقل ۸ کاراکتر باشد.",
    email_taken: "این ایمیل قبلاً ثبت شده است.",
    invalid_pin: "پین باید ۴ تا ۱۲ رقم باشد.",
    pin_taken: "این پین در این شعبه استفاده شده است. پین دیگری انتخاب کنید.",
    already_initialized: "این سیستم قبلاً راه‌اندازی شده است.",
    costing_locked: "روش قیمت‌گذاری قفل شده و از این‌جا قابل تغییر نیست.",
    costing_not_set: "اول روش قیمت‌گذاری را در مرحلهٔ ۳ انتخاب کنید.",
    accounts_in_use: "حساب‌ها دارای سند هستند و قابل جایگزینی نیستند.",
    invalid_rate: "نرخ مالیات باید بین ۰ و ۱۰۰ باشد.",
    category_exists: "دسته‌ای با این نام وجود دارد.",
    category_not_found: "دسته پیدا نشد.",
    unsupported_format: "فرمت فایل پشتیبانی نمی‌شود (CSV یا Excel .xlsx).",
    parse_failed: "خواندن فایل ممکن نشد.",
    file_too_large: "حجم فایل بیش از حد مجاز است.",
    nothing_to_import: "هیچ سطر معتبری در فایل نبود.",
    printer_not_found: "چاپگر پیدا نشد.",
    no_items: "حداقل یک قلم لازم است.",
    invalid_item: "مقدار یا بهای یکی از اقلام معتبر نیست.",
    opening_entry_exists: "سند افتتاحیه قبلاً ثبت شده است.",
    not_balanced: "سند تراز نیست: جمع بدهکار و بستانکار برابر نیستند.",
    unknown_account: "حساب ناشناخته در سطرها وجود دارد.",
    offset_account_missing: "حساب «تراز افتتاحیه» (کد ۳۹۰۰) در سرفصل‌ها نیست.",
    incomplete: "هنوز مراحل الزامی کامل نشده‌اند.",
    no_location: "شعبه‌ای ثبت نشده است.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}

export function ErrorBox({ children }: { children: React.ReactNode }) {
  if (!children) return null;
  return (
    <Alert
      variant="destructive"
      className="mb-4 border-destructive/30 bg-destructive/5"
    >
      <CircleAlertIcon />
      <AlertDescription className="text-destructive">
        {children}
      </AlertDescription>
    </Alert>
  );
}

export function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <Alert className="mb-4 border-primary/30 bg-primary/5">
      <InfoIcon className="text-primary" />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

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
      <span className="mb-1 block text-sm font-medium text-foreground">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

/** shadcn <Input>-equivalent classes for raw <input>/<select>/<textarea> elements. */
export const inputClass =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 py-1 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50";

export function PrimaryButton({
  children,
  disabled,
  onClick,
  type = "submit",
}: {
  children: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
  type?: "submit" | "button";
}) {
  return (
    <Button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="px-5 font-semibold"
    >
      {children}
    </Button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      className="px-4"
    >
      {children}
    </Button>
  );
}

/** Data-shaped fallback for client-loaded wizard steps. */
export function SetupDataSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label="در حال بارگذاری اطلاعات مرحله"
    >
      <div aria-hidden="true" className="space-y-6">
        <header className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-[28rem] max-w-full" />
        </header>
        <div className="space-y-4">
          {Array.from({ length: rows }, (_, row) => (
            <div key={row} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full rounded-lg" />
            </div>
          ))}
        </div>
        <div className="flex justify-between border-t border-border/80 pt-4">
          <Skeleton className="h-10 w-24 rounded-lg" />
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
      </div>
    </div>
  );
}

/**
 * Common frame for a wizard step: title, description, content, and the
 * back / skip navigation row. "Next" is each form's own submit button.
 */
export function StepShell({
  step,
  description,
  children,
  showSkip,
  showNext,
}: {
  step: WizardStep;
  description: React.ReactNode;
  children: React.ReactNode;
  showSkip?: boolean;
  /** steps whose forms don't auto-advance (menu, users, …) get a plain next button */
  showNext?: boolean;
}) {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = stepsFor(industry);
  const meta = STEPS[stepIndex(step)];
  const back = prevPath(step, steps);
  const [skipping, setSkipping] = useState(false);

  async function skip() {
    setSkipping(true);
    await api("/api/setup/progress", {
      method: "POST",
      body: JSON.stringify({ step }),
    });
    router.push(nextPath(step, steps));
  }

  const currentIndex = steps.findIndex((item) => item.id === step);
  const progress = Math.round(((currentIndex + 1) / steps.length) * 100);

  return (
    <div>
      <header className="mb-7 border-b border-border pb-6">
        <div className="mb-4 flex items-center justify-between gap-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
            مرحلهٔ {toPersianDigits(currentIndex + 1)} از{" "}
            {toPersianDigits(steps.length)}
          </p>
          <span className="text-xs text-muted-foreground">
            {toPersianDigits(progress)}٪ پیشرفت
          </span>
        </div>
        <div
          className="mb-5 h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-amber-500 dark:bg-amber-400 transition-[width] duration-500"
            style={{ width: `${progress}%` }}
          />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {meta.title}
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </header>

      {children}

      <div className="mt-8 flex items-center justify-between border-t pt-4">
        <div>
          {back ? (
            <SecondaryButton onClick={() => router.push(back)}>
              مرحلهٔ قبل
            </SecondaryButton>
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          {showSkip ? (
            <button
              type="button"
              onClick={skip}
              disabled={skipping}
              className="text-sm text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline disabled:opacity-50"
            >
              فعلاً رد شدن از این مرحله
            </button>
          ) : null}
          {showNext ? (
            <PrimaryButton
              type="button"
              onClick={() => router.push(nextPath(step, steps))}
            >
              مرحلهٔ بعد
            </PrimaryButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}
