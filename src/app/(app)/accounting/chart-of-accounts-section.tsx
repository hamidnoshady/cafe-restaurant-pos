"use client";

import { EmptyState, SectionCard, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";

import { useEffect, useState } from "react";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import type { Runner } from "./accounting-manager";
import {
  ACCOUNT_LEVEL_LABELS,
  WELL_KNOWN_CODES,
  nextAccountLevel,
  type AccountLevel,
  type NormalBalance,
} from "@/lib/coa-template";
import { AccountHistoryPanel } from "./account-history-panel";
import { AccountStatementPanel } from "./account-statement-panel";
import { overlayPanelClass } from "@/app/dashboard/page-chrome";
import { useOverlayEscape } from "./use-overlay-escape";

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
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [visibility, setVisibility] = useState<"all" | "active" | "archived">("all");
  const [reload, setReload] = useState(0);
  const [statementAccount, setStatementAccount] = useState<{ id: string; code: string; name: string } | null>(null);
  const [historyAccount, setHistoryAccount] = useState<{ id: string; code: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  /*
   * «ویرایش» — renaming and reparenting.
   *
   * `PATCH /api/ledger/accounts/:id` has supported both since Phase 16, the
   * audit trail records both (`account.renamed` / `account.reparented`, shown by
   * `AccountHistoryPanel`) and this component's own doc comment claimed both,
   * but the screen only ever offered archive and delete: a mistyped account
   * name could be read, audited and reverted — just not corrected.
   */
  const [editing, setEditing] = useState<AccountRow | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    void api<{ accounts: AccountRow[] }>("/api/ledger/accounts?all=1")
      .then(({ ok, data }) => {
        if (ok) {
          setAccounts(data.accounts);
          setLoadFailed(false);
        }
        // An endless skeleton reads as "still loading"; name the failure instead.
        else setLoadFailed(true);
      })
      .catch(() => setLoadFailed(true));
  }, [reload]);

  function refresh() {
    setAccounts(null);
    setLoadFailed(false);
    setReload((n) => n + 1);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    setSaving(true);
    try {
      const { ok, data } = await api<{ error?: string }>("/api/ledger/accounts", {
        method: "POST",
        body: JSON.stringify({ code, name, type, parentId: parentId || null, isContra }),
      });
      if (!ok) {
        setLocalError(errorLabels[data.error ?? ""] ?? errorMessage(data.error));
        return;
      }
      setCode("");
      setName("");
      setParentId("");
      setIsContra(false);
      refresh();
    } catch {
      setLocalError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(a: AccountRow) {
    setLocalError("");
    const ok = await run(() =>
      api(`/api/ledger/accounts/${a.id}`, { method: "PATCH", body: JSON.stringify({ isActive: !a.isActive }) }),
    );
    if (ok) refresh();
  }

  function remove(a: AccountRow) {
    setLocalError("");
    setDeleting(a);
  }

  async function confirmRemove() {
    if (!deleting) return;
    setSaving(true);
    try {
      const { ok, data } = await api<{ error?: string }>(`/api/ledger/accounts/${deleting.id}`, { method: "DELETE" });
      if (!ok) {
        setLocalError(errorLabels[data.error ?? ""] ?? errorMessage(data.error));
        return;
      }
      setDeleting(null);
      refresh();
    } catch {
      setLocalError("ارتباط با سرور برقرار نشد؛ دوباره تلاش کنید.");
    } finally {
      setSaving(false);
    }
  }

  if (!accounts) {
    if (loadFailed) {
      return (
        <div className="space-y-3">
          <ErrorBox>بارگذاری سرفصل حساب‌ها ناموفق بود.</ErrorBox>
          <div className="max-w-xs">
            <SecondaryButton onClick={refresh}>تلاش دوباره</SecondaryButton>
          </div>
        </div>
      );
    }
    return <SectionCardSkeleton rows={4} />;
  }

  // Only an account that can still take a child: a «تفصیلی» parent is refused
  // server-side (`parent_too_deep`), so offering it is offering an error.
  const parentOptions = accounts.filter((a) => a.isActive && nextAccountLevel(a.level) !== null);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const actionBusy = busy || saving;
  const filteredAccounts = accounts.filter((account) => {
    const matchesVisibility =
      visibility === "all" || (visibility === "active" ? account.isActive : !account.isActive);
    if (!matchesVisibility) return false;
    if (!normalizedSearch) return true;
    return `${account.code} ${account.name} ${account.parentCode ?? ""}`
      .toLocaleLowerCase()
      .includes(normalizedSearch);
  });

  return (
    <div className="space-y-4">
      <SectionCard
        title="افزودن حساب"
        description="فقط حساب‌های مجاز جدید را اضافه کنید؛ حساب‌های سیستمی و دارای سند همچنان با قوانین فعلی محافظت می‌شوند."
        bodyClassName="p-0"
      >
        {localError ? <div className="px-4 pt-4 sm:px-5"><ErrorBox>{localError}</ErrorBox></div> : null}
        <form onSubmit={submit} className="grid gap-3 p-4 sm:p-5 md:grid-cols-2 xl:grid-cols-4" dir="rtl">
          <Field label="کد حساب">
            <input className={inputClass} dir="ltr" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} placeholder="مثلاً ۶۱۰۰" required />
          </Field>
          <Field label="نام حساب">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام حساب" required />
          </Field>
          <Field label="نوع حساب">
            <SearchableSelect
              value={type}
              onChange={(value) => setType(value as AccountType)}
              options={(Object.keys(TYPE_LABELS) as AccountType[]).map((t) => ({ value: t, label: TYPE_LABELS[t] }))}
            />
          </Field>
          <Field label="حساب والد">
            <SearchableSelect
              value={parentId}
              onChange={setParentId}
              options={[
                { value: "", label: "بدون والد (سطح گروه)" },
                ...parentOptions.map((a) => ({ value: a.id, label: `${a.code} — ${a.name} (${ACCOUNT_LEVEL_LABELS[a.level]})` })),
              ]}
            />
          </Field>
          <label className="flex items-end gap-2 pb-2.5">
            <input type="checkbox" checked={isContra} onChange={(e) => setIsContra(e.target.checked)} />
            <span className="text-sm font-medium">حساب کاهنده (مثلاً برگشت از فروش)</span>
          </label>
          <div className="md:col-span-2 xl:col-span-4">
            <div className="max-w-xs"><PrimaryButton disabled={actionBusy}>افزودن حساب</PrimaryButton></div>
          </div>
        </form>
      </SectionCard>

      <SectionCard
        title="سرفصل حساب‌ها"
        description={`${filteredAccounts.length.toLocaleString("fa-IR")} حساب از ${accounts.length.toLocaleString("fa-IR")} حساب نمایش داده می‌شود.`}
        bodyClassName="p-0"
      >
        <div className="border-b border-border/80 p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">جست‌وجوی حساب</span>
              <input
                className={inputClass}
                type="search"
                dir="auto"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="کد، نام یا حساب والد…"
                aria-label="جست‌وجوی سرفصل حساب‌ها"
              />
            </label>
            <div className="grid grid-cols-3 gap-2 sm:min-w-72">
              {([
                ["all", "همه"],
                ["active", "فعال"],
                ["archived", "بایگانی‌شده"],
              ] as const).map(([key, label]) => (
                <Button
                  key={key}
                  type="button"
                  variant="outline"
                  aria-pressed={visibility === key}
                  onClick={() => setVisibility(key)}
                  className={`min-h-10 rounded-xl px-3 text-sm font-medium ${
                    visibility === key
                      ? "border-amber-200 bg-amber-100 text-amber-950 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200 dark:hover:bg-amber-500/20"
                      : "border-border/80 bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {label}
                </Button>
              ))}
            </div>
          </div>
        </div>
        <div className="p-4 sm:p-5">
          {filteredAccounts.length === 0 ? (
            <EmptyState>
              {accounts.length === 0
                ? "هنوز سرفصلی ثبت نشده است. از فرم بالا اولین حساب را اضافه کنید."
                : "حسابی با این فیلتر پیدا نشد؛ عبارت جست‌وجو یا وضعیت را تغییر دهید."}
            </EmptyState>
          ) : null}
          <div className={`${filteredAccounts.length === 0 ? "hidden" : ""} overflow-hidden rounded-xl border border-border/80 lg:block`}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-stone-50 text-stone-500 dark:bg-stone-800/40 dark:text-stone-400"><tr className="border-b border-border"><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">کد</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">حساب</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">نوع</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">سطح</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">ماهیت</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">والد</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">وضعیت</th><th className="px-4 py-3 text-start text-xs font-medium sm:text-sm">عملیات</th></tr></thead>
                <tbody>
                  {filteredAccounts.map((a) => (
                    <tr key={a.id} className="border-b border-border last:border-b-0">
                      <td dir="ltr" className="px-4 py-3 text-start font-medium tabular-nums text-muted-foreground">{a.code}</td>
                      <td className="px-4 py-3 font-semibold text-foreground">
                        {a.name}
                        {WELL_KNOWN_CODE_SET.has(a.code) ? <span className="ms-2 align-middle"><StatusBadge tone="active">سیستمی</StatusBadge></span> : null}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{TYPE_LABELS[a.type]}</td>
                      <td className="px-4 py-3 text-muted-foreground">{ACCOUNT_LEVEL_LABELS[a.level]}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {NORMAL_BALANCE_LABELS[a.normalBalance]}
                        {a.isContra ? <span className="ms-1 text-xs">(کاهنده)</span> : null}
                      </td>
                      <td dir="ltr" className="px-4 py-3 text-start tabular-nums text-muted-foreground">{a.parentCode ?? "—"}</td>
                      <td className="px-4 py-3"><StatusBadge tone={a.isActive ? "positive" : "neutral"}>{a.isActive ? "فعال" : "غیرفعال"}</StatusBadge></td>
                      <td className="px-4 py-3"><div className="flex flex-wrap gap-2"><SecondaryButton onClick={() => { setLocalError(""); setEditing(a); }} disabled={actionBusy}>ویرایش</SecondaryButton><SecondaryButton onClick={() => setStatementAccount({ id: a.id, code: a.code, name: a.name })}>گردش حساب</SecondaryButton><SecondaryButton onClick={() => setHistoryAccount({ id: a.id, code: a.code, name: a.name })}>تاریخچه</SecondaryButton><SecondaryButton onClick={() => toggleActive(a)} disabled={actionBusy}>{a.isActive ? "غیرفعال کردن" : "فعال کردن"}</SecondaryButton>{!a.hasPostings && !a.hasChildren ? <SecondaryButton onClick={() => remove(a)} disabled={actionBusy}>حذف</SecondaryButton> : null}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="space-y-3 lg:hidden">
            {filteredAccounts.map((a) => (
              <article key={a.id} className="rounded-xl border border-border/80 bg-stone-50/60 p-4 dark:bg-stone-800/30">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p dir="ltr" className="text-start text-xs font-medium tabular-nums text-muted-foreground">{a.code}</p>
                    <h3 className="mt-1 truncate text-sm font-semibold text-foreground">
                      {a.name}
                      {WELL_KNOWN_CODE_SET.has(a.code) ? <span className="ms-2 align-middle"><StatusBadge tone="active">سیستمی</StatusBadge></span> : null}
                    </h3>
                  </div>
                  <StatusBadge tone={a.isActive ? "positive" : "neutral"}>{a.isActive ? "فعال" : "غیرفعال"}</StatusBadge>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-sm">
                  <div><dt className="text-xs text-muted-foreground">نوع</dt><dd className="mt-1 text-foreground">{TYPE_LABELS[a.type]}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">سطح</dt><dd className="mt-1 text-foreground">{ACCOUNT_LEVEL_LABELS[a.level]}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">ماهیت</dt><dd className="mt-1 text-foreground">{NORMAL_BALANCE_LABELS[a.normalBalance]}{a.isContra ? " (کاهنده)" : ""}</dd></div>
                  <div><dt className="text-xs text-muted-foreground">والد</dt><dd dir="ltr" className="mt-1 text-start tabular-nums text-foreground">{a.parentCode ?? "—"}</dd></div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2"><SecondaryButton onClick={() => { setLocalError(""); setEditing(a); }} disabled={actionBusy}>ویرایش</SecondaryButton><SecondaryButton onClick={() => setStatementAccount({ id: a.id, code: a.code, name: a.name })}>گردش حساب</SecondaryButton><SecondaryButton onClick={() => setHistoryAccount({ id: a.id, code: a.code, name: a.name })}>تاریخچه</SecondaryButton><SecondaryButton onClick={() => toggleActive(a)} disabled={actionBusy}>{a.isActive ? "غیرفعال کردن" : "فعال کردن"}</SecondaryButton>{!a.hasPostings && !a.hasChildren ? <SecondaryButton onClick={() => remove(a)} disabled={actionBusy}>حذف</SecondaryButton> : null}</div>
              </article>
            ))}
          </div>
        </div>
      </SectionCard>

      {statementAccount ? (
        <AccountStatementPanel
          accountId={statementAccount.id}
          accountCode={statementAccount.code}
          accountName={statementAccount.name}
          onClose={() => setStatementAccount(null)}
        />
      ) : null}

      {editing ? (
        <EditAccountPanel
          account={editing}
          parentOptions={parentOptions.filter((candidate) => candidate.id !== editing.id)}
          busy={busy}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
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

      {deleting ? (
        <DeleteAccountPanel
          account={deleting}
          busy={actionBusy}
          error={localError}
          onClose={() => setDeleting(null)}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </div>
  );
}

/**
 * Rename an account, move it under another, or both.
 *
 * One PATCH covers both edits (`renameAccount` / `reparentAccount` behind the
 * same route), and only the fields that actually changed are sent — the route
 * treats a present `parentId` as an instruction, so sending an unchanged one
 * would write an audit row saying it moved when it did not.
 *
 * `code` and `type` are deliberately absent: the auto-posting engine looks
 * accounts up *by code* (`WELL_KNOWN_CODES`), and the account's type decides
 * which side of the statements it lands on. Neither is a rename — changing
 * either is a new account plus a reclassifying entry, which is a different
 * (and audited) operation.
 */
function EditAccountPanel({
  account,
  parentOptions,
  busy,
  onClose,
  onSaved,
}: {
  account: AccountRow;
  parentOptions: AccountRow[];
  busy: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(account.name);
  const [parentId, setParentId] = useState(account.parentId ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useOverlayEscape(onClose);

  const nameChanged = name.trim() !== account.name;
  const parentChanged = (parentId || null) !== (account.parentId ?? null);
  const canSave = !!name.trim() && (nameChanged || parentChanged);

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError("");
    const body: { name?: string; parentId?: string | null } = {};
    if (nameChanged) body.name = name.trim();
    if (parentChanged) body.parentId = parentId || null;
    const { ok, data } = await api<{ error?: string }>(`/api/ledger/accounts/${account.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setSaving(false);
    if (!ok) {
      const code = (data as { error?: string }).error;
      setError(errorLabels[code ?? ""] ?? errorMessage(code));
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-account-heading"
        className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 border-b border-border pb-4">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ویرایش حساب</p>
          <h3 id="edit-account-heading" className="mt-1 text-lg font-bold">
            <span dir="ltr">{account.code}</span> — {account.name}
          </h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            کد و نوع حساب قابل تغییر نیستند؛ سندهای خودکار حساب‌ها را با کد پیدا می‌کنند.
          </p>
        </header>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <div className="space-y-3">
          <Field label="نام حساب">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام حساب" />
          </Field>
          <Field label="حساب والد">
            <SearchableSelect
              value={parentId}
              onChange={setParentId}
              ariaLabel="حساب والد"
              options={[
                { value: "", label: "بدون والد (سطح گروه)" },
                ...parentOptions.map((a) => ({ value: a.id, label: `${a.code} — ${a.name} (${ACCOUNT_LEVEL_LABELS[a.level]})` })),
              ]}
            />
            {account.hasChildren ? (
              <span className="mt-1.5 block text-xs leading-5 text-muted-foreground">
                زیرمجموعه‌های این حساب هم همراه آن جابه‌جا می‌شوند.
              </span>
            ) : null}
          </Field>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={saving || busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton onClick={() => void save()} disabled={saving || busy || !canSave}>
            {saving ? "در حال ذخیره…" : "ذخیره تغییرات"}
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}

function DeleteAccountPanel({
  account,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  account: AccountRow;
  busy: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  useOverlayEscape(onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4" onClick={onClose}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-account-heading"
        className={`${overlayPanelClass} w-full max-w-md p-4 sm:p-5`}
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-xs font-semibold text-rose-700 dark:text-rose-300">حذف سرفصل</p>
        <h3 id="delete-account-heading" className="mt-1 text-lg font-bold">
          حذف <span dir="ltr">{account.code}</span> — {account.name}؟
        </h3>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          این کار فقط وقتی انجام می‌شود که حساب هیچ سند، پیش‌نویس یا زیرمجموعه‌ای نداشته باشد و قابل بازگشت نیست.
        </p>
        {error ? <div className="mt-4"><ErrorBox>{error}</ErrorBox></div> : null}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <SecondaryButton onClick={onClose} disabled={busy}>انصراف</SecondaryButton>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "در حال حذف…" : "حذف حساب"}
          </Button>
        </div>
      </section>
    </div>
  );
}
