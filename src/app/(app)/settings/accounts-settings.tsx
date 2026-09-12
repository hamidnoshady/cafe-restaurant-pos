"use client";

import { useCallback, useState } from "react";
import { ChartOfAccountsSection } from "@/app/(app)/accounting/chart-of-accounts-section";
import type { Runner } from "@/app/(app)/accounting/accounting-manager";
import { ErrorBox, InfoBox, errorMessage } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";

/**
 * Accounting settings is the administration surface for the chart of accounts.
 *
 * This used to be a second, destructive "replace the entire chart" editor. It
 * also had an unrelated payment-method heading and hid the account features
 * that already existed in the Accounting workspace (archive, re-parent,
 * statements and audit history). Keeping two editors meant the settings page
 * and the ledger page could disagree about what an account was.
 *
 * The chart editor is now shared with Accounting so both entry points expose
 * the same guarded operations and the same RTL-first design language.
 */
export function AccountsSettings() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = useCallback<Runner>(async (operation) => {
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      if (!result.ok) {
        setError(errorMessage(result.data.error));
        return false;
      }
      return true;
    } catch {
      setError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <div className="space-y-5">
      <ErrorBox>{error}</ErrorBox>
      <InfoBox>
        در این بخش ساختار حساب‌ها را مدیریت می‌کنید. برای حفظ سوابق، حساب‌های دارای سند حذف نمی‌شوند و فقط می‌توان آن‌ها را غیرفعال کرد؛ حساب‌های سیستمی نیز همیشه محافظت می‌شوند.
      </InfoBox>
      <SectionCard
        title="تنظیمات حسابداری"
        description="افزودن، ویرایش، جابه‌جایی و بایگانی سرفصل‌ها، همراه با گردش حساب و تاریخچهٔ تغییرات."
      >
        <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
          کد و نوع حساب پس از ایجاد ثابت می‌ماند تا ثبت‌های خودکار و گزارش‌های مالی پایدار بمانند. برای شخصی‌سازی، نام یا حساب والد را ویرایش کنید و برای حساب‌های قدیمی از بایگانی استفاده کنید.
        </p>
      </SectionCard>
      <ChartOfAccountsSection busy={busy} run={run} />
    </div>
  );
}
