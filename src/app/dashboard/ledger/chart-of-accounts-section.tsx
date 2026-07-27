"use client";

import { useEffect, useState } from "react";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { Runner } from "./ledger-manager";

type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

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
      body: JSON.stringify({ code, name, type, parentId: parentId || null }),
    });
    if (!ok) return setLocalError(errorLabels[(data as { error?: string }).error ?? ""] ?? errorMessage(data.error));
    setCode("");
    setName("");
    setParentId("");
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

  if (!accounts) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  const parentOptions = accounts.filter((a) => a.isActive);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">افزودن حساب</h2>
        {localError ? <p className="mb-3 text-sm text-destructive">{localError}</p> : null}
        <form onSubmit={submit} className="grid gap-2 sm:grid-cols-5">
          <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} placeholder="کد" required />
          <input
            className={`${inputClass} sm:col-span-2`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="نام حساب"
            required
          />
          <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <select className={inputClass} value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">بدون والد</option>
            {parentOptions.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name}
              </option>
            ))}
          </select>
          <div className="sm:col-span-5">
            <PrimaryButton disabled={busy}>افزودن حساب</PrimaryButton>
          </div>
        </form>
      </section>

      <section className="rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-3 font-semibold">سرفصل حساب‌ها</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-start text-muted-foreground">
                <th className="py-2 pe-3 text-start">کد</th>
                <th className="py-2 pe-3 text-start">حساب</th>
                <th className="py-2 pe-3 text-start">نوع</th>
                <th className="py-2 pe-3 text-start">والد</th>
                <th className="py-2 pe-3 text-start">وضعیت</th>
                <th className="py-2 text-start">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id} className="border-b border-border">
                  <td className="py-2 pe-3 text-muted-foreground">{a.code}</td>
                  <td className="py-2 pe-3">{a.name}</td>
                  <td className="py-2 pe-3 text-muted-foreground">{TYPE_LABELS[a.type]}</td>
                  <td className="py-2 pe-3 text-muted-foreground">{a.parentCode ?? "—"}</td>
                  <td className="py-2 pe-3">
                    {a.isActive ? (
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
                        فعال
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                        غیرفعال
                      </span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex flex-wrap gap-2">
                      <SecondaryButton onClick={() => toggleActive(a)} disabled={busy}>
                        {a.isActive ? "غیرفعال کردن" : "فعال کردن"}
                      </SecondaryButton>
                      {!a.hasPostings && !a.hasChildren ? (
                        <SecondaryButton onClick={() => remove(a)} disabled={busy}>
                          حذف
                        </SecondaryButton>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
