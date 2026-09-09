"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarDaysIcon,
  CalculatorIcon,
  CircleIcon,
  ClipboardListIcon,
  ScrollTextIcon,
  TrendingUpIcon,
  UsersIcon,
} from "lucide-react";
import { SectionNav } from "../section-nav";
import { api, ErrorBox } from "../ui";
import { useSearchParams } from "next/navigation";
import { partyScopeFor } from "@/lib/parties-scopes";
import { PartiesSection } from "../parties/parties-section";
import { TrialBalanceSection } from "./trial-balance-section";
import { EntriesSection } from "./entries-section";
import { ManualEntrySection } from "./manual-entry-section";
import { FiscalPeriodsSection } from "./fiscal-periods-section";
import { ArSection } from "./ar-section";
import { ApSection } from "./ap-section";
import { ReceiptsPaymentsSection } from "./receipts-payments-section";
import { InstallmentsSection } from "./installments-section";
import { ChequesSection } from "./cheques-section";
import { ReconciliationSection } from "./reconciliation-section";
import { ChartOfAccountsSection } from "./chart-of-accounts-section";
import { ExpenseSection } from "./expense-section";
import { PayrollSection } from "./payroll-section";
import { VatReportSection } from "./vat-report-section";
import { FixedAssetsSection } from "./fixed-assets-section";
import { GrowthAccountingView } from "@/components/growth/growth-accounting-view";
import styles from "./ledger-workspace.module.css";

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense";
  parent_code: string | null;
}

const TABS = [
  { key: "trial-balance", label: "تراز آزمایشی", icon: CalculatorIcon },
  { key: "entries", label: "دفتر روزنامه", icon: ClipboardListIcon },
  { key: "manual", label: "ثبت سند دستی", icon: ClipboardListIcon },
  { key: "expenses", label: "هزینه‌ها", icon: CircleIcon },
  { key: "fiscal-periods", label: "دوره‌های مالی", icon: CalendarDaysIcon },
  { key: "parties", label: "اشخاص", icon: UsersIcon },
  { key: "customers", label: "مشتریان", icon: UsersIcon },
  { key: "ar", label: "حساب‌های دریافتنی", icon: UsersIcon },
  { key: "ap", label: "حساب‌های پرداختنی", icon: UsersIcon },
  { key: "receipts", label: "دریافت و پرداخت", icon: ScrollTextIcon },
  { key: "installments", label: "اقساط", icon: CalendarDaysIcon },
  { key: "cheques", label: "چک‌ها", icon: ScrollTextIcon },
  { key: "reconciliation", label: "تطبیق بانکی", icon: CircleIcon },
  { key: "chart-of-accounts", label: "سرفصل حساب‌ها", icon: CalculatorIcon },
  { key: "payroll", label: "حقوق و دستمزد", icon: UsersIcon },
  { key: "vat", label: "گزارش مالیات", icon: CircleIcon },
  { key: "fixed-assets", label: "دارایی‌های ثابت", icon: CircleIcon },
  { key: "growth", label: "رشد و بازاریابی", icon: TrendingUpIcon },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export function LedgerManager({ role }: { role: string }) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /*
   * «اشخاص» is Accounting's own view of the same table the CRM, the store and
   * the team look at (`../parties/parties-section.tsx`, scope `accounting`) —
   * customers, suppliers and staff with the ledger's own columns, managed here
   * rather than by sending the accountant into the CRM. It is also the one place
   * a party's ledger code is written.
   *
   * «مشتریان» is the customers-only slice (`scope accounting-customers`): it is the
   * destination the A/R customer actions point at, so an accountant looking at a
   * receivable lands on the customers they can settle with, not on Growth's
   * marketing projection and not on the supplier/staff rows of the persons file.
   *
   * A `?party=<id>` link from another app (a CRM row, an AI answer, a
   * notification) lands on a tab with that one file open, the way `?customer=`
   * lands on the CRM's. A named `?tab=` wins, so `?tab=customers&party=<id>` opens
   * the accounting customer file rather than the whole counterparty list. The tabs
   * are only *reachable* from those links, so the default tab is unchanged: the
   * ledger's front door stays the trial balance.
   */
  const searchParams = useSearchParams();
  const partyParam = searchParams.get("party");
  // A named tab wins over `?party=`'s implicit one, and both are checked against
  // `TABS` so a stale bookmark cannot park the page on a section that no longer
  // exists (the state type is `TabKey`, and an unchecked cast is how it would lie).
  const tabParam = TABS.find((item) => item.key === searchParams.get("tab"))?.key;
  const [tab, setTab] = useState<TabKey>(() =>
    tabParam ?? (partyParam ? "parties" : "trial-balance"),
  );
  const [editPartyId, setEditPartyId] = useState<string | null>(partyParam);
  useEffect(() => {
    if (!partyParam) return;
    setTab(tabParam ?? "parties");
    setEditPartyId(partyParam);
  }, [partyParam, tabParam]);
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

  if (!accounts) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <SectionNav
        idPrefix="ledger"
        label="بخش‌های حسابداری"
        title="فضای کار حسابداری"
        description="ثبت، بررسی و گزارش‌های مالی"
        variant="rail"
        sections={tabs}
        active={tab}
        onChange={setTab}
      >
        <div className={`${styles.content} min-w-0`}>
          {tab === "trial-balance" ? <TrialBalanceSection refreshKey={refreshKey} /> : null}
          {tab === "entries" ? <EntriesSection refreshKey={refreshKey} busy={busy} run={run} /> : null}
          {tab === "manual" ? <ManualEntrySection accounts={accounts} busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {tab === "expenses" ? <ExpenseSection accounts={accounts} busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {tab === "fiscal-periods" ? <FiscalPeriodsSection busy={busy} run={run} /> : null}
          {tab === "parties" ? (
            <PartiesSection
              scope={partyScopeFor("accounting")}
              role={role}
              editPartyId={editPartyId}
            />
          ) : null}
          {tab === "customers" ? (
            <PartiesSection
              scope={partyScopeFor("accounting-customers")}
              role={role}
              editPartyId={editPartyId}
            />
          ) : null}
          {tab === "ar" ? <ArSection busy={busy} run={run} /> : null}
          {tab === "ap" ? <ApSection busy={busy} run={run} /> : null}
          {tab === "receipts" ? <ReceiptsPaymentsSection /> : null}
          {tab === "installments" ? <InstallmentsSection /> : null}
          {tab === "cheques" ? <ChequesSection busy={busy} run={run} /> : null}
          {tab === "reconciliation" ? <ReconciliationSection busy={busy} run={run} /> : null}
          {tab === "chart-of-accounts" ? <ChartOfAccountsSection busy={busy} run={run} /> : null}
          {tab === "payroll" ? <PayrollSection busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {tab === "vat" ? <VatReportSection refreshKey={refreshKey} /> : null}
          {tab === "fixed-assets" ? <FixedAssetsSection busy={busy} refreshKey={refreshKey} /> : null}
          {tab === "growth" ? <GrowthAccountingView /> : null}
        </div>
      </SectionNav>
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
    // Phase 30 — cheques
    invalid_direction: "نوع چک معتبر نیست.",
    invalid_action: "این عملیات روی چک تعریف نشده است.",
    invalid_cheque_transition: "این تغییر وضعیت برای چک ممکن نیست؛ ممکن است وضعیت چک را کسی دیگر تغییر داده باشد.",
    cheque_not_found: "چک پیدا نشد.",
    duplicate_cheque: "چکی با همین شماره و بانک (یا همین شناسه صیاد) قبلاً ثبت شده است.",
    invalid_sayad_id: "شناسه صیاد باید ۱۶ رقم باشد.",
    serial_number_required: "شماره چک الزامی است.",
    bank_name_required: "نام بانک الزامی است.",
    counterparty_name_required: "نام صاحب چک الزامی است.",
    due_date_required: "تاریخ سررسید الزامی است.",
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
