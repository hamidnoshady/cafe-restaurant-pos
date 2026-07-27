"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox } from "../ui";
import { TrialBalanceSection } from "./trial-balance-section";
import { EntriesSection } from "./entries-section";
import { ManualEntrySection } from "./manual-entry-section";
import { FiscalPeriodsSection } from "./fiscal-periods-section";
import { ArSection } from "./ar-section";
import { ApSection } from "./ap-section";
import { ReconciliationSection } from "./reconciliation-section";
import { ChartOfAccountsSection } from "./chart-of-accounts-section";
import { ExpenseSection } from "./expense-section";
import { PayrollSection } from "./payroll-section";

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parent_code: string | null;
}

const TABS = [
  { key: "trial-balance", label: "تراز آزمایشی" },
  { key: "entries", label: "دفتر روزنامه" },
  { key: "manual", label: "ثبت سند دستی" },
  { key: "expenses", label: "هزینه‌ها" },
  { key: "fiscal-periods", label: "دوره‌های مالی" },
  { key: "ar", label: "حساب‌های دریافتنی" },
  { key: "ap", label: "حساب‌های پرداختنی" },
  { key: "reconciliation", label: "تطبیق بانکی" },
  { key: "chart-of-accounts", label: "سرفصل حساب‌ها" },
  { key: "payroll", label: "حقوق و دستمزد" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function LedgerManager({ role }: { role: string }) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<TabKey>("trial-balance");
  const [refreshKey, setRefreshKey] = useState(0);

  // Wages are compensation data — restricted to owner + accountant, unlike
  // every other tab here (owner/manager/accountant).
  const tabs = TABS.filter((t) => t.key !== "payroll" || role === "owner" || role === "accountant");

  const loadAccounts = useCallback(() => {
    api<{ accounts: AccountRow[] }>("/api/ledger/accounts").then(({ ok, data }) => {
      if (ok) setAccounts(data.accounts);
    });
  }, []);
  useEffect(loadAccounts, [loadAccounts]);

  async function run(fn: () => Promise<{ ok: boolean; data: { error?: string } }>) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    setRefreshKey((k) => k + 1);
    return true;
  }

  if (!accounts) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>

      <div className="flex flex-wrap gap-2 border-b border-border pb-2">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm ${
              tab === t.key ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "trial-balance" ? <TrialBalanceSection refreshKey={refreshKey} /> : null}
      {tab === "entries" ? <EntriesSection refreshKey={refreshKey} busy={busy} run={run} /> : null}
      {tab === "manual" ? <ManualEntrySection accounts={accounts} busy={busy} run={run} refreshKey={refreshKey} /> : null}
      {tab === "expenses" ? <ExpenseSection accounts={accounts} busy={busy} run={run} refreshKey={refreshKey} /> : null}
      {tab === "fiscal-periods" ? <FiscalPeriodsSection busy={busy} run={run} /> : null}
      {tab === "ar" ? <ArSection busy={busy} run={run} /> : null}
      {tab === "ap" ? <ApSection busy={busy} run={run} /> : null}
      {tab === "reconciliation" ? <ReconciliationSection busy={busy} run={run} /> : null}
      {tab === "chart-of-accounts" ? <ChartOfAccountsSection busy={busy} run={run} /> : null}
      {tab === "payroll" ? <PayrollSection busy={busy} run={run} refreshKey={refreshKey} /> : null}
    </div>
  );
}

export type Runner = (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;

function errorMessage(code: string | undefined): string {
  const map: Record<string, string> = {
    memo_required: "شرح سند الزامی است.",
    no_lines: "حداقل یک سطر با مبلغ لازم است.",
    invalid_line: "یکی از سطرها معتبر نیست (حساب، یا فقط بدهکار یا بستانکار).",
    not_balanced: "مجموع بدهکار و بستانکار برابر نیست.",
    unknown_account: "یکی از حساب‌های انتخاب‌شده معتبر نیست.",
    ledger_account_missing: "یکی از حساب‌های مورد نیاز سیستم در سرفصل حساب‌ها یافت نشد.",
    unauthorized: "وارد نشده‌اید.",
    forbidden: "دسترسی مجاز نیست.",
    bad_request: "درخواست نامعتبر بود.",
    // Phase 16 — AR subledger
    customer_required: "انتخاب مشتری الزامی است.",
    customer_not_found: "مشتری انتخاب‌شده معتبر نیست.",
    invalid_amount: "مبلغ معتبر نیست.",
    invalid_method: "روش دریافت/پرداخت معتبر نیست.",
    // Phase 16 — AP subledger
    supplier_required: "انتخاب تأمین‌کننده الزامی است.",
    supplier_not_found: "تأمین‌کننده انتخاب‌شده معتبر نیست.",
    // Phase 16 — bank & cash reconciliation
    invalid_account: "حساب انتخاب‌شده معتبر نیست.",
    statement_date_required: "تاریخ صورتحساب الزامی است.",
    reconciliation_in_progress: "یک تطبیق ناتمام برای این حساب وجود دارد؛ ابتدا آن را تکمیل کنید.",
    reconciliation_not_found: "تطبیق پیدا نشد.",
    reconciliation_completed: "این تطبیق قبلاً قفل شده و قابل تغییر نیست.",
    journal_line_not_found: "سند انتخاب‌شده معتبر نیست.",
    balance_mismatch: "مانده محاسبه‌شده با مانده صورتحساب برابر نیست.",
    fiscal_period_locked: "دوره مالی این تاریخ قفل است و امکان ثبت سند وجود ندارد.",
    fiscal_period_soft_closed: "دوره مالی این تاریخ بسته‌ی موقت است؛ فقط مالک یا حسابدار می‌تواند سند ثبت کند.",
    // Phase 16 — manual journal workflow
    draft_not_found: "پیش‌نویس پیدا نشد.",
    entry_not_found: "سند پیدا نشد.",
    not_reversible: "فقط اسناد دستی قابل برگشت هستند.",
    cannot_reverse_a_reversal: "سند برگشتی را نمی‌توان دوباره برگشت زد.",
    already_reversed: "این سند قبلاً برگشت خورده است.",
    // Phase 16 — chart of accounts customisation
    well_known_account: "این حساب برای عملکرد سیستم لازم است و قابل غیرفعال یا حذف نیست.",
    account_not_found: "حساب پیدا نشد.",
    // Phase 16 — expense management
    invalid_expense_account: "دسته هزینه انتخاب‌شده یک حساب هزینه معتبر نیست.",
    invalid_payment_account: "حساب پرداخت انتخاب‌شده معتبر نیست.",
    same_account: "دسته هزینه و حساب پرداخت نمی‌توانند یکسان باشند.",
    // Phase 16 — payroll entries
    user_not_found: "عضو موردنظر پیدا نشد.",
    no_wages_set: "هیچ عضو فعالی حقوق تعیین‌شده ندارد.",
    period_label_required: "عنوان دوره الزامی است.",
    run_not_found: "تعهد حقوق پیدا نشد.",
    already_paid: "این تعهد قبلاً پرداخت شده است.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
