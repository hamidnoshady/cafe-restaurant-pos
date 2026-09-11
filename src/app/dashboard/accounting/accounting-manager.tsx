"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  CalendarDaysIcon,
  CalculatorIcon,
  CircleIcon,
  ClipboardListIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  TrendingUpIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { SectionNav } from "../section-nav";
import { api, ErrorBox, SecondaryButton } from "../ui";
import { partyScopeFor } from "@/lib/parties-scopes";
import { PartiesSection } from "../parties/parties-section";
import { LedgerDashboardSection } from "./ledger-dashboard-section";
import {
  accountingSectionHref,
  type AccountingSectionKey,
} from "./accounting-routes";
import { accountingSectionsForRole } from "./accounting-nav";
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

/**
 * The in-page rail's glyphs. Icons stay here (a client concern) while the
 * section *list* lives in `accounting-nav.ts`, which the server-side sidebar
 * also reads — the same split `crm-nav.ts` and `growth-nav.ts` keep.
 */
const SECTION_ICONS: Record<AccountingSectionKey, LucideIcon> = {
  dashboard: LayoutDashboardIcon,
  "trial-balance": CalculatorIcon,
  entries: ClipboardListIcon,
  manual: ClipboardListIcon,
  expenses: CircleIcon,
  "fiscal-periods": CalendarDaysIcon,
  directory: UsersIcon,
  customers: UsersIcon,
  ar: UsersIcon,
  ap: UsersIcon,
  receipts: ScrollTextIcon,
  installments: CalendarDaysIcon,
  cheques: ScrollTextIcon,
  reconciliation: CircleIcon,
  "chart-of-accounts": CalculatorIcon,
  payroll: UsersIcon,
  vat: CircleIcon,
  "fixed-assets": CircleIcon,
  growth: TrendingUpIcon,
};

export function AccountingManager({ role, section }: { role: string; section: AccountingSectionKey }) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  /*
   * «اشخاص» (the directory) is Accounting's own view of the same table the
   * CRM, the store and the team look at (`../parties/parties-section.tsx`,
   * scope `accounting`) — customers, suppliers and staff with the ledger's own
   * columns, managed here rather than by sending the accountant into the CRM.
   * It is also the one place a party's ledger code is written.
   *
   * «مشتریان» is the customers-only slice (`scope accounting-customers`): it
   * is the destination the A/R customer actions point at, so an accountant
   * looking at a receivable lands on the customers they can settle with — an
   * accounting page, never a redirect into the CRM.
   *
   * A `?party=<id>` link from another app (an A/R row, an AI answer, a
   * notification) lands on the section's route with that one file open, the
   * way `?customer=` lands on the CRM's file.
   */
  const router = useRouter();
  const searchParams = useSearchParams();
  const partyParam = searchParams.get("party");
  const [editPartyId, setEditPartyId] = useState<string | null>(partyParam);
  useEffect(() => {
    setEditPartyId(partyParam);
  }, [partyParam]);
  const [refreshKey, setRefreshKey] = useState(0);

  // Every section is a route now, so the rail navigates rather than switching
  // local state — a section a person lands on is a URL they can keep.
  const goToSection = useCallback(
    (key: AccountingSectionKey) => {
      router.push(accountingSectionHref(key));
    },
    [router],
  );

  // Wages are compensation data — restricted to owner + accountant; the list
  // comes from `accounting-nav.ts`, the same source the sidebar reads.
  const sections = accountingSectionsForRole(role).map((s) => ({
    ...s,
    icon: SECTION_ICONS[s.key],
  }));

  const [loadFailed, setLoadFailed] = useState(false);
  const loadAccounts = useCallback(() => {
    setLoadFailed(false);
    api<{ accounts: AccountRow[] }>("/api/ledger/accounts").then(({ ok, data }) => {
      if (ok) setAccounts(data.accounts);
      // Without this the whole workspace sat on a skeleton for ever whenever
      // the chart of accounts failed to load — indistinguishable from a slow
      // network, and with no way to retry.
      else setLoadFailed(true);
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
    if (loadFailed) {
      return (
        <div className="space-y-3">
          <ErrorBox>بارگذاری سرفصل حساب‌ها ناموفق بود؛ بخش‌های حسابداری بدون آن باز نمی‌شوند.</ErrorBox>
          <div className="max-w-xs">
            <SecondaryButton onClick={loadAccounts}>تلاش دوباره</SecondaryButton>
          </div>
        </div>
      );
    }
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>

      <SectionNav
        idPrefix="accounting"
        label="بخش‌های حسابداری"
        title="فضای کار حسابداری"
        description="ثبت، بررسی و گزارش‌های مالی"
        variant="rail"
        sections={sections}
        active={section}
        onChange={goToSection}
      >
        <div className={`${styles.content} min-w-0`}>
          {section === "dashboard" ? <LedgerDashboardSection onGoToTab={goToSection} refreshKey={refreshKey} /> : null}
          {section === "trial-balance" ? <TrialBalanceSection refreshKey={refreshKey} /> : null}
          {section === "entries" ? <EntriesSection refreshKey={refreshKey} busy={busy} run={run} /> : null}
          {section === "manual" ? <ManualEntrySection accounts={accounts} busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {section === "expenses" ? <ExpenseSection accounts={accounts} busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {section === "fiscal-periods" ? <FiscalPeriodsSection busy={busy} run={run} /> : null}
          {section === "directory" ? (
            <PartiesSection
              scope={partyScopeFor("accounting")}
              role={role}
              editPartyId={editPartyId}
            />
          ) : null}
          {section === "customers" ? (
            <PartiesSection
              scope={partyScopeFor("accounting-customers")}
              role={role}
              editPartyId={editPartyId}
            />
          ) : null}
          {section === "ar" ? <ArSection busy={busy} run={run} /> : null}
          {section === "ap" ? <ApSection busy={busy} run={run} /> : null}
          {section === "receipts" ? <ReceiptsPaymentsSection /> : null}
          {section === "installments" ? <InstallmentsSection /> : null}
          {section === "cheques" ? <ChequesSection busy={busy} run={run} /> : null}
          {section === "reconciliation" ? <ReconciliationSection busy={busy} run={run} /> : null}
          {section === "chart-of-accounts" ? <ChartOfAccountsSection busy={busy} run={run} /> : null}
          {section === "payroll" ? <PayrollSection busy={busy} run={run} refreshKey={refreshKey} /> : null}
          {section === "vat" ? <VatReportSection refreshKey={refreshKey} /> : null}
          {section === "fixed-assets" ? <FixedAssetsSection busy={busy} refreshKey={refreshKey} /> : null}
          {section === "growth" ? <GrowthAccountingView /> : null}
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
    // Chart of accounts (accounts-service.ts) — these reach here whenever a
    // section routes an accounts error through `run` rather than its own map.
    code_required: "کد حساب الزامی است.",
    name_required: "نام حساب الزامی است.",
    invalid_type: "نوع حساب معتبر نیست.",
    code_in_use: "این کد حساب قبلاً استفاده شده است.",
    parent_not_found: "حساب والد پیدا نشد.",
    parent_cycle: "حساب نمی‌تواند والد خودش یا زیرمجموعه‌اش باشد.",
    parent_too_deep: "حساب والد از سطح «تفصیلی» است و نمی‌تواند زیرمجموعه داشته باشد.",
    hierarchy_too_deep: "این جابه‌جایی باعث می‌شود ساختار حساب از سطح «تفصیلی» عمیق‌تر شود.",
    account_has_postings: "این حساب سند خورده و قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.",
    account_has_draft_postings: "این حساب در یک پیش‌نویس استفاده شده و قابل حذف نیست.",
    account_has_children: "ابتدا زیرمجموعه‌های این حساب را جابه‌جا یا حذف کنید.",
    // Fiscal years and periods (fiscal-periods-service.ts)
    invalid_year: "سال شمسی نامعتبر است.",
    fiscal_year_exists: "این سال مالی قبلاً تعریف شده است.",
    fiscal_year_not_found: "سال مالی یافت نشد.",
    fiscal_year_closed: "سال مالی این دوره بسته شده و دیگر قابل بازگشایی نیست.",
    fiscal_year_already_closed: "این سال مالی قبلاً بسته شده است.",
    periods_not_ready: "برای بستن سال مالی، ابتدا همه دوره‌های آن را به‌صورت موقت ببندید.",
    period_locked_for_closing: "دوره پایانی سال قفل است؛ ابتدا آن را بازگشایی و دوباره بسته‌ی موقت کنید.",
    period_not_found: "دوره یافت نشد.",
    invalid_transition: "این تغییر وضعیت مجاز نیست.",
    // Phase 16 — payroll entries
    user_not_found: "عضو موردنظر پیدا نشد.",
    no_wages_set: "هیچ عضو فعالی حقوق تعیین‌شده ندارد.",
    period_label_required: "عنوان دوره الزامی است.",
    run_not_found: "تعهد حقوق پیدا نشد.",
    already_paid: "این تعهد قبلاً پرداخت شده است.",
  };
  return map[code ?? ""] ?? "خطای غیرمنتظره. دوباره تلاش کنید.";
}
