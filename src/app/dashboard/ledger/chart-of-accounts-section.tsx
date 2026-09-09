"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { Runner } from "./ledger-manager";
import { ACCOUNT_LEVEL_LABELS, WELL_KNOWN_CODES, type AccountLevel, type NormalBalance } from "@/lib/coa-template";
import { AccountHistoryPanel } from "./account-history-panel";
import { AccountStatementPanel } from "./account-statement-panel";
import { cardClass } from "../page-chrome";

type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

const NORMAL_BALANCE_LABELS: Record<NormalBalance, string> = {
  debit: "بدهکار",
  credit: "بستانکار",
};

const WELL_KNOWN_CODE_SET = new Set<string>(Object.values(WELL_KNOWN_CODES));

const errorLabels: Record<string, string> = {
  code_required: "کد حساب الزامی است.",
  name_required: "نام حساب الزامی است.",
  invalid_type: "نوع حساب معتبر نیست.",
  parent_not_found: "حساب والد پیدا نشد.",
  code_in_use: "این کد حساب قبلاً استفاده شده است.",
  account_not_found: "حساب پیدا نشد.",
  parent_cycle: "حساب نمی‌تواند والد خودش یا زیرمجموعه‌اش باشد.",
  well_known_account: "این حساب برای عملکرد سیستم لازم است و قابل غیرفعال یا حذف نیست.",
  account_has_postings: "این حساب سند خورده و قابل حذف نیست؛ می‌توانید آن را غیرفعال کنید.",
  account_has_draft_postings: "این حساب در یک پیش‌نویس استفاده شده و قابل حذف نیست.",
  account_has_children: "ابتدا زیرمجموعه‌های این حساب را جابه‌جا یا حذف کنید.",
  parent_too_deep: "حساب والد از سطح «تفصیلی» است و نمی‌تواند زیرمجموعه داشته باشد.",
  hierarchy_too_deep: "این جابه‌جایی باعث می‌شود ساختار حساب از سطح «تفصیلی» عمیق‌تر شود.",
};

interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  parentCode: string | null;
  isActive: boolean;
  hasPostings: boolean;
  hasChildren: boolean;
  level: AccountLevel;
  normalBalance: NormalBalance;
  isContra: boolean;
}

/**
 * Chart-of-accounts customisation: add sub-accounts, rename, reparent, and
 * archive/restore or delete — first real use of accounts.edit anywhere in
 * the codebase. Archiving keeps every historical posting intact (it's still
 * in every statement/report ever produced) and only stops the account being
 * offered for new ones; deleting is only ever allowed for an account that
 * was never posted to (real or drafted) and has no sub-accounts of its own.
 */
export function ChartOfAccountsSection({ busy, run }: { busy: boolean; run: Runner }) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [localError, setLocalError] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AccountType>("expense");
  const [parentId, setParentId] = useState("");
  const [isContra, setIsContra] = useState(false);
  const [reload, setReload] = useState(0);
  const [statementAccount, setStatementAccount] = useState<{ id: string; code: string; name: string } | null>(null);
  const [historyAccount, setHistoryAccount] = useState<{ id: string; code: string; name: string } | null>(null);

  useEffect(() => {
    api<{ accounts: AccountRow[] }>("/api/ledger/accounts?all=1").then(({ ok, data }) => {
      if (ok) setAccounts(data.accounts);
    });
  }, [reload]);

  function refresh() {
    setReload((n) => n + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    const { ok, data } = await api<{ error?: string }>("/api/ledger/accounts", {
      method: "POST",
      body: JSON.stringify({ code, name, type, parentId: parentId || null, isContra }),
    });
    if (!ok) return setLocalError(errorLabels[(data as { error?: string }).error ?? ""] ?? errorMessage(data.error));
    setCode("");
    setName("");
    setParentId("");
    setIsContra(false);
    refresh();
  }

  async function toggleActive(a: AccountRow) {
    setLocalError("");
    const ok = await run(() =>
      api(`/api/ledger/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !a.isActive }) }),
    );
    if (ok) refresh();
  }

  async function remove(a: AccountRow) {
    setLocalError("");
    const { ok, data } = await api(`/api/ledger/accounts/${a.id}`, { method: "DELETE" });
    if (!ok) return setLocalError(errorLabels[(data as { error?: string }).error ?? ""] ?? errorMessage((data as { error?: string }).error));
    refresh();
  }

  if (!accounts) {
    return <SectionCardSkeleton rows={4} />;
  }

  const parentOptions = accounts.filter((a) => a.isActive);

  return (
    <div className="space-y-4">
      <section aria-labelledby="add-account-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ساختار مالی</p>
          <h2 id="add-account-heading" className="mt-1 text-base font-semibold text-foreground">افزودن حساب</h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">
            فقط حساب‌های مجاز جدید را اضافه کنید؛ حساب‌های سیستمی و دارای سند همچنان با قوانین فعلی محافظت می‌شوند.
          </p>
        </header>
        {localError ? <p className="mx-4 mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive sm:mx-5">{localError}</p> : null}
        <form onSubmit={submit} className="grid gap-3 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-4">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">کد حساب</span>
            <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} placeholder="مثلاً ۶۱۰۰" required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">نام حساب</span>
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام حساب" required />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">نوع حساب</span>
            <SearchableSelect
              value={type}
              onChange={(value) => setType(value as AccountType)}
              options={(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">حساب والد</span>
            <SearchableSelect
              value={parentId}
              onChange={setParentId}
              options={[
                { value: "", label: "بدون والد (سطح گروه)" },
                ...parentOptions.map((a) => ({ value: a.id, label: `${a.code} — ${a.name} (${ACCOUNT_LEVEL_LABELS[a.level]})` })),
              ]}
            />
          </label>
          <label className="flex items-end gap-2 pb-2.5">
            <input type="checkbox" checked={isContra} onChange={(e) => setIsContra(e.target.checked)} />
            <span className="text-sm font-medium">حساب کاهنده (مثلاً برگشت از فروش)</span>
          </label>
          <div className="md:col-span-2 xl:col-span-4">
            <div className="max-w-xs"><PrimaryButton disabled={busy}>افزودن حساب</PrimaryButton></div>
          </div>
        </form>
      </section>

      <section aria-labelledby="chart-accounts-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">فهرست ساختار</p>
          <h2 id="chart-accounts-heading" className="mt-1 text-base font-semibold text-foreground">سرفصل حساب‌ها</h2>
        </header>
        <div className="p-4 sm:p-5">
          <div className="hidden overflow-hidden rounded-xl border border-border/80 lg:block">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">کد</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">حساب</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">نوع</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">سطح</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">ماهیت</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">والد</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">وضعیت</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">عملیات</th></tr></thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3 font-medium text-muted-foreground">{a.code}</td>
                      <td className="px-4 py-3 font-semibold text-foreground">
                        {a.name}
                        {WELL_KNOWN_CODE_SET.has(a.code) ? <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">سیستمی</span> : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{TYPE_LABELS[a.type]}</td>
                      <td className="px-4 py-3 text-muted-foreground">{ACCOUNT_LEVEL_LABELS[a.level]}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {NORMAL_BALANCE_LABELS[a.normalBalance]}
                        {a.isContra ? <span className="ms-1 text-xs">(کاهنده)</span> : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{a.parentCode ?? "—"}</td>
                      <td className="px-4 py-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${a.isActive ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" : "bg-muted text-muted-foreground"}`}>{a.isActive ? "فعال" : "غیرفعال"}</span></td>
                      <td className="px-4 py-3"><div className="flex flex-wrap gap-2"><SecondaryButton onClick={() => setStatementAccount({ id: a.id, code: a.code, name: a.name })}>گردش حساب</SecondaryButton><SecondaryButton onClick={() => setHistoryAccount({ id: a.id, code: a.code, name: a.name })}>تاریخچه</SecondaryButton><SecondaryButton onClick={() => toggleActive(a)} disabled={busy}>{a.isActive ? "غیرفعال کردن" : "فعال کردن"}</SecondaryButton>{!a.hasPostings && !a.hasChildren ? <SecondaryButton onClick={() => remove(a)} disabled={busy}>حذف</SecondaryButton> : null}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 lg:hidden">
            {accounts.map((a) => (
              <article key={a.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-muted-foreground">{a.code}</p>
                    <h3 className="mt-1 truncate text-sm font-semibold text-foreground">
                      {a.name}
                      {WELL_KNOWN_CODE_SET.has(a.code) ? <span className="ms-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">سیستمی</span> : null}
                    </h3>
                  </div>
                  <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${a.isActive ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/15 dark:text-emerald-200" : "bg-muted text-muted-foreground"}`}>{a.isActive ? "فعال" : "غیرفعال"}</span>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                  <div><dt className="text-xs text-muted-foreground">نوع</dt><dd className="mt-1 text-foreground">{TYPE_LABELS[a.type]}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">سطح</dt><dd className="mt-1 text-foreground">{ACCOUNT_LEVEL_LABELS[a.level]}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">ماهیت</dt><dd className="mt-1 text-foreground">{NORMAL_BALANCE_LABELS[a.normalBalance]}{a.isContra ? " (کاهنده)" : ""}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">والد</dt><dd className="mt-1 text-foreground">{a.parentCode ?? "—"}</dd></div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2"><SecondaryButton onClick={() => setStatementAccount({ id: a.id, code: a.code, name: a.name })}>گردش حساب</SecondaryButton><SecondaryButton onClick={() => setHistoryAccount({ id: a.id, code: a.code, name: a.name })}>تاریخچه</SecondaryButton><SecondaryButton onClick={() => toggleActive(a)} disabled={busy}>{a.isActive ? "غیرفعال کردن" : "فعال کردن"}</SecondaryButton>{!a.hasPostings && !a.hasChildren ? <SecondaryButton onClick={() => remove(a)} disabled={busy}>حذف</SecondaryButton> : null}</div>
              </article>
            ))}
          </div>
        </div>
      </section>

      {statementAccount ? (
        <AccountStatementPanel
          accountId={statementAccount.id}
          accountCode={statementAccount.code}
          accountName={statementAccount.name}
          onClose={() => setStatementAccount(null)}
        />
      ) : null}

      {historyAccount ? (
        <AccountHistoryPanel
          accountId={historyAccount.id}
          accountCode={historyAccount.code}
          accountName={historyAccount.name}
          onClose={() => setHistoryAccount(null)}
        />
      ) : null}
    </div>
  );
}
