"use client";

import { useEffect, useState } from "react";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { Runner } from "./ledger-manager";
import { ACCOUNT_LEVEL_LABELS, WELL_KNOWN_CODES, type AccountLevel, type NormalBalance } from "@/lib/coa-template";

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
    return <section aria-live="polite" className="rounded-2xl bg-card p-5 text-sm text-muted-foreground shadow-sm">در حال بارگذاری…</section>;
  }

  const parentOptions = accounts.filter((a) => a.isActive);

  return (
    <div className="space-y-4">
      <section className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
        <p className="text-xs font-semibold text-[#9B6700]">ساختار مالی</p>
        <h2 className="mt-1">افزودن حساب</h2>
        <p className="mt-2 text-sm text-muted-foreground">فقط حساب‌های مجاز جدید را اضافه کنید؛ حساب‌های سیستمی و دارای سند همچنان با قوانین فعلی محافظت می‌شوند.</p>
        {localError ? <p className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">{localError}</p> : null}
        <form onSubmit={submit} className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
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
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as AccountType)}>
              {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">حساب والد</span>
            <select className={inputClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">بدون والد (سطح گروه)</option>
              {parentOptions.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name} ({ACCOUNT_LEVEL_LABELS[a.level]})</option>)}
            </select>
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

      <section className="rounded-2xl bg-card p-4 shadow-sm sm:p-5">
        <div className="mb-4">
          <p className="text-xs font-semibold text-[#9B6700]">فهرست ساختار</p>
          <h2 className="mt-1">سرفصل حساب‌ها</h2>
        </div>
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border"><th className="py-3 pe-3 text-start">کد</th><th className="py-3 pe-3 text-start">حساب</th><th className="py-3 pe-3 text-start">نوع</th><th className="py-3 pe-3 text-start">سطح</th><th className="py-3 pe-3 text-start">ماهیت</th><th className="py-3 pe-3 text-start">والد</th><th className="py-3 pe-3 text-start">وضعیت</th><th className="py-3 text-start">عملیات</th></tr></thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-border">
                  <td className="py-3 pe-3 text-muted-foreground">{a.code}</td>
                  <td className="py-3 pe-3 font-semibold">
                    {a.name}
                    {WELL_KNOWN_CODE_SET.has(a.code) ? <span className="ms-2 rounded-full bg-[#F3EEE3] px-2 py-0.5 text-xs font-semibold text-[#9B6700]">سیستمی</span> : null}
                  </td>
                  <td className="py-3 pe-3 text-muted-foreground">{TYPE_LABELS[a.type]}</td>
                  <td className="py-3 pe-3 text-muted-foreground">{ACCOUNT_LEVEL_LABELS[a.level]}</td>
                  <td className="py-3 pe-3 text-muted-foreground">
                    {NORMAL_BALANCE_LABELS[a.normalBalance]}
                    {a.isContra ? <span className="ms-1 text-xs">(کاهنده)</span> : null}
                  </td>
                  <td className="py-3 pe-3 text-muted-foreground">{a.parentCode ?? "—"}</td>
                  <td className="py-3 pe-3"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${a.isActive ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>{a.isActive ? "فعال" : "غیرفعال"}</span></td>
                  <td className="py-3"><div className="flex flex-wrap gap-2"><SecondaryButton onClick={() => toggleActive(a)} disabled={busy}>{a.isActive ? "غیرفعال کردن" : "فعال کردن"}</SecondaryButton>{!a.hasPostings && !a.hasChildren ? <SecondaryButton onClick={() => remove(a)} disabled={busy}>حذف</SecondaryButton> : null}</div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="space-y-3 lg:hidden">
          {accounts.map((a) => (
            <article key={a.id} className="rounded-xl border border-[#EEECE7] bg-[#FCFBF8] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{a.code}</p>
                  <h3 className="mt-1 truncate">
                    {a.name}
                    {WELL_KNOWN_CODE_SET.has(a.code) ? <span className="ms-2 rounded-full bg-[#F3EEE3] px-2 py-0.5 text-xs font-semibold text-[#9B6700]">سیستمی</span> : null}
                  </h3>
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold ${a.isActive ? "bg-emerald-100 text-emerald-800" : "bg-muted text-muted-foreground"}`}>{a.isActive ? "فعال" : "غیرفعال"}</span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-[#F0EEE9] pt-3 text-sm">
                <div><dt className="text-xs text-muted-foreground">نوع</dt><dd className="mt-1">{TYPE_LABELS[a.type]}</dd></div>
                <div><dt className="text-xs text-muted-foreground">سطح</dt><dd className="mt-1">{ACCOUNT_LEVEL_LABELS[a.level]}</dd></div>
                <div><dt className="text-xs text-muted-foreground">ماهیت</dt><dd className="mt-1">{NORMAL_BALANCE_LABELS[a.normalBalance]}{a.isContra ? " (کاهنده)" : ""}</dd></div>
                <div><dt className="text-xs text-muted-foreground">والد</dt><dd className="mt-1">{a.parentCode ?? "—"}</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap gap-2"><SecondaryButton onClick={() => toggleActive(a)} disabled={busy}>{a.isActive ? "غیرفعال کردن" : "فعال کردن"}</SecondaryButton>{!a.hasPostings && !a.hasChildren ? <SecondaryButton onClick={() => remove(a)} disabled={busy}>حذف</SecondaryButton> : null}</div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
