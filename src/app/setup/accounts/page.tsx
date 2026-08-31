"use client";

import { SetupDataSkeleton } from "../ui";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { AccountType, TemplateAccount } from "@/lib/coa-template";
import { toPersianDigits } from "@/lib/digits";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";
import { nextPath, stepsFor } from "../steps";
import { useSetupIndustry } from "../industry-context";
import { INDUSTRY_LABELS } from "@/lib/industries";

const TYPE_LABELS: Record<AccountType, string> = {
  asset: "دارایی",
  liability: "بدهی",
  equity: "حقوق صاحبان سرمایه",
  revenue: "درآمد",
  expense: "هزینه",
};

interface AccountsResponse {
  template: TemplateAccount[];
  existing: { code: string; name: string; type: AccountType; parent_code: string | null }[];
  error?: string;
}

export default function AccountsStep() {
  const router = useRouter();
  const industry = useSetupIndustry();
  const steps = stepsFor(industry);
  const [rows, setRows] = useState<TemplateAccount[]>([]);
  const [existingCount, setExistingCount] = useState(0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api<AccountsResponse>("/api/setup/accounts").then(({ data }) => {
      if (data.existing?.length) {
        setExistingCount(data.existing.length);
        setRows(
          data.existing.map((a) => ({
            code: a.code,
            name: a.name,
            type: a.type,
            parentCode: a.parent_code ?? undefined,
          })),
        );
      } else if (data.template) {
        setRows(data.template);
      }
    }).finally(() => setLoaded(true));
  }, []);

  function update(i: number, patch: Partial<TemplateAccount>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  }

  function addRow() {
    setRows((rs) => [...rs, { code: "", name: "", type: "expense" }]);
  }

  function removeRow(i: number) {
    setRows((rs) => rs.filter((_, j) => j !== i));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; messages?: string[] }>("/api/setup/accounts", {
      method: "POST",
      body: JSON.stringify({ accounts: rows }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error, data.messages));
      return;
    }
    router.push(nextPath("accounts", steps));
  }

  if (!loaded) return <SetupDataSkeleton rows={4} />;

  return (
    <StepShell
      step="accounts"
      description={`سرفصل پیشنهادی مخصوص «${INDUSTRY_LABELS[industry]}» آماده است؛ می‌توانید همین را ثبت کنید یا سطرها را ویرایش کنید.`}
    >
      {existingCount > 0 ? (
        <InfoBox>
          {toPersianDigits(existingCount)} حساب از قبل ثبت شده است. ثبت دوباره، سرفصل فعلی را
          جایگزین می‌کند (تا وقتی سندی صادر نشده باشد).
        </InfoBox>
      ) : null}
      <form onSubmit={submit}>
        <ErrorBox>{error}</ErrorBox>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="p-2 text-start font-medium">کد</th>
                <th className="p-2 text-start font-medium">نام حساب</th>
                <th className="p-2 text-start font-medium">نوع</th>
                <th className="p-2 text-start font-medium">والد</th>
                <th className="w-10 p-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="p-1.5">
                    <input
                      className={`${inputClass} w-20`}
                      dir="ltr"
                      value={r.code}
                      onChange={(e) => update(i, { code: e.target.value })}
                    />
                  </td>
                  <td className="p-1.5">
                    <input
                      className={inputClass}
                      value={r.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                    />
                  </td>
                  <td className="p-1.5">
                    <SearchableSelect
                      className={inputClass}
                      value={r.type}
                      onChange={(value) => update(i, { type: value as AccountType })}
                      ariaLabel="نوع حساب"
                      options={Object.entries(TYPE_LABELS).map(([v, label]) => ({ value: v, label }))}
                    />
                  </td>
                  <td className="p-1.5">
                    <input
                      className={`${inputClass} w-20`}
                      dir="ltr"
                      value={r.parentCode ?? ""}
                      onChange={(e) => update(i, { parentCode: e.target.value || undefined })}
                      placeholder="—"
                    />
                  </td>
                  <td className="p-1.5 text-center">
                    <button
                      type="button"
                      onClick={() => removeRow(i)}
                      className="text-muted-foreground hover:text-destructive"
                      title="حذف"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <PrimaryButton disabled={busy || rows.length === 0}>
            ثبت {toPersianDigits(rows.length)} حساب و ادامه
          </PrimaryButton>
          <SecondaryButton onClick={addRow}>افزودن حساب</SecondaryButton>
        </div>
      </form>
    </StepShell>
  );
}
