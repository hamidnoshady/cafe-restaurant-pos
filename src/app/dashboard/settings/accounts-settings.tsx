"use client";

import { useCallback, useEffect, useState } from "react";
import { ACCOUNT_TYPES, FNB_COA_TEMPLATE, type AccountType, type TemplateAccount } from "@/lib/coa-template";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

interface ExistingAccount {
  code: string;
  name: string;
  type: AccountType;
  parent_code: string | null;
}

interface AccountsResponse {
  template?: TemplateAccount[];
  existing?: ExistingAccount[];
  error?: string;
}

function normalise(accounts: TemplateAccount[]): TemplateAccount[] {
  return accounts.map((account) => ({
    code: String(account.code ?? ""),
    name: String(account.name ?? ""),
    type: account.type,
    parentCode: account.parentCode || undefined,
  }));
}

/** Editable chart of accounts. Replacement is blocked after journals reference it. */
export function AccountsSettings() {
  const [accounts, setAccounts] = useState<TemplateAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { ok, data } = await api<AccountsResponse>("/api/settings/accounts");
    if (ok) {
      const existing = data.existing ?? [];
      setAccounts(
        existing.length > 0
          ? normalise(existing.map(({ code, name, type, parent_code }) => ({ code, name, type, parentCode: parent_code ?? undefined })))
          : normalise(data.template ?? FNB_COA_TEMPLATE),
      );
      setError("");
    } else {
      setError(errorMessage(data.error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function change(index: number, patch: Partial<TemplateAccount>) {
    setSaved(false);
    setAccounts((current) => current.map((account, row) => (row === index ? { ...account, ...patch } : account)));
  }

  function add() {
    setSaved(false);
    setAccounts((current) => [...current, { code: "", name: "", type: "asset" }]);
  }

  function remove(index: number) {
    setSaved(false);
    setAccounts((current) => current.filter((_, row) => row !== index));
  }

  async function save() {
    setSaving(true);
    setError("");
    setSaved(false);
    const { ok, data } = await api<{ error?: string; messages?: string[] }>("/api/settings/accounts", {
      method: "PUT",
      body: JSON.stringify({ accounts: normalise(accounts) }),
    });
    setSaving(false);
    if (!ok) {
      setError(data.messages?.join(" ") || errorMessage(data.error));
      return;
    }
    setSaved(true);
  }

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>
      {saved ? <InfoBox>سرفصل حساب‌ها ذخیره شد.</InfoBox> : null}

      <SectionCard title="سرفصل حساب‌ها">
        <p className="mb-4 text-sm text-muted-foreground">
          ساختار حساب‌های مالی را اینجا نگه‌داری کنید. اگر اسناد حسابداری ثبت شده باشند، برای حفظ یکپارچگی دیگر جایگزین‌کردن ساختار ممکن نیست.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          <SecondaryButton onClick={() => { setAccounts(normalise(FNB_COA_TEMPLATE)); setSaved(false); }}>
            بازگردانی الگوی کافه و رستوران
          </SecondaryButton>
          <SecondaryButton onClick={add}>افزودن سرفصل</SecondaryButton>
        </div>

        <div className="space-y-3">
          {accounts.map((account, index) => (
            <div key={`${account.code}-${index}`} className="grid gap-2 rounded-xl border border-stone-200/80 p-3 md:grid-cols-[7rem_1fr_9rem_1fr_auto]">
              <input className={inputClass} dir="ltr" value={account.code} onChange={(e) => change(index, { code: e.target.value })} placeholder="کد" aria-label="کد حساب" />
              <input className={inputClass} value={account.name} onChange={(e) => change(index, { name: e.target.value })} placeholder="نام حساب" aria-label="نام حساب" />
              <SearchableSelect
                value={account.type}
                onChange={(value) => change(index, { type: value as AccountType })}
                ariaLabel="نوع حساب"
                options={ACCOUNT_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
              />
              <SearchableSelect
                value={account.parentCode ?? ""}
                onChange={(value) => change(index, { parentCode: value || undefined })}
                ariaLabel="حساب والد"
                dir="ltr"
                options={[
                  { value: "", label: "بدون والد" },
                  ...accounts
                    .filter((candidate, candidateIndex) => candidateIndex !== index && candidate.code)
                    .map((candidate) => ({ value: candidate.code, label: `${candidate.code} — ${candidate.name || "بدون نام"}` })),
                ]}
              />
              <SecondaryButton onClick={() => remove(index)}>حذف</SecondaryButton>
            </div>
          ))}
        </div>
        {accounts.length === 0 ? <p className="mt-4 text-sm text-muted-foreground">حداقل یک سرفصل اضافه کنید.</p> : null}
      </SectionCard>

      <div className="max-w-xs">
        <PrimaryButton onClick={save} type="button" disabled={saving}>{saving ? "در حال ذخیره…" : "ذخیرهٔ سرفصل‌ها"}</PrimaryButton>
      </div>
    </div>
  );
}
