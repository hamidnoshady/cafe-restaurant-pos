"use client";

import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ErrorBox, Field, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  isActive: boolean;
  createdAt: string;
}

const BRANCH_ERROR_LABELS: Record<string, string> = {
  last_active_branch: "این تنها شعبهٔ فعال کسب‌وکار است و قابل غیرفعال‌سازی نیست.",
  branch_has_open_orders: "این شعبه سفارش باز دارد و قابل غیرفعال‌سازی نیست.",
  branch_has_open_sessions: "این شعبه نشست میز باز دارد و قابل غیرفعال‌سازی نیست.",
  source_branch_not_found: "شعبهٔ مبدأ برای کپی منو پیدا نشد.",
};

function branchErrorMessage(code: string | undefined): string {
  return code ? (BRANCH_ERROR_LABELS[code] ?? errorMessage(code)) : errorMessage(code);
}

export function BranchesManager() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ branches: Branch[] }>("/api/branches");
    if (res.ok) setBranches(res.data.branches);
    else setError(branchErrorMessage((res.data as { error?: string }).error));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createBranch() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>("/api/branches", {
      method: "POST",
      body: JSON.stringify({
        name,
        address: address || undefined,
        phone: phone || undefined,
        copyMenuFromLocationId: copyFrom || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(branchErrorMessage(res.data.error));
      return;
    }
    setName("");
    setAddress("");
    setPhone("");
    setCopyFrom("");
    await load();
  }

  async function toggleActive(branch: Branch) {
    setError("");
    const res = await api<{ error?: string }>(`/api/branches/${branch.id}`, {
      method: "PATCH",
      body: JSON.stringify({ isActive: !branch.isActive }),
    });
    if (!res.ok) {
      setError(branchErrorMessage(res.data.error));
      return;
    }
    await load();
  }

  async function rename(branch: Branch) {
    const next = prompt("نام جدید شعبه", branch.name);
    if (!next || !next.trim() || next.trim() === branch.name) return;
    const res = await api<{ error?: string }>(`/api/branches/${branch.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: next.trim() }),
    });
    if (!res.ok) {
      setError(branchErrorMessage(res.data.error));
      return;
    }
    await load();
  }

  if (loading) return <LoadingSkeleton rows={3} />;

  const activeBranches = branches.filter((b) => b.isActive);

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard title="شعب" flush>
        {branches.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز شعبه‌ای ثبت نشده است.</EmptyState>
          </div>
        ) : (
          <ul className="space-y-2 p-4 sm:p-5">
            {branches.map((branch) => (
              <li
                key={branch.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                    {branch.name}
                    <StatusBadge tone={branch.isActive ? "positive" : "neutral"}>
                      {branch.isActive ? "فعال" : "غیرفعال"}
                    </StatusBadge>
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {[branch.address, branch.phone].filter(Boolean).join(" · ") || "بدون آدرس/تلفن ثبت‌شده"}
                    {" · ایجاد "}
                    {toPersianDigits(formatJalali(new Date(branch.createdAt)))}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <SecondaryButton onClick={() => rename(branch)}>تغییر نام</SecondaryButton>
                  <SecondaryButton onClick={() => toggleActive(branch)}>
                    {branch.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}
                  </SecondaryButton>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="افزودن شعبهٔ جدید" description="شعبهٔ جدید با همان سرفصل حساب‌ها و تنظیمات مالی کسب‌وکار کار می‌کند.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام شعبه">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="آدرس">
            <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
          <Field label="تلفن">
            <input
              className={inputClass}
              dir="ltr"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </Field>
          <Field label="کپی منو از شعبهٔ دیگر (اختیاری)">
            <SearchableSelect
              value={copyFrom}
              onChange={setCopyFrom}
              options={[
                { value: "", label: "بدون کپی — منوی خالی" },
                ...activeBranches.map((branch) => ({ value: branch.id, label: branch.name })),
              ]}
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          کپی فقط ساختار منو (دسته‌ها، آیتم‌ها و افزودنی‌ها) را شامل می‌شود؛ موجودی انبار، دستور پخت و
          چاپگرها منتقل نمی‌شوند، چون به‌صورت فیزیکی مختص هر شعبه‌اند. سرفصل حساب‌ها در کل کسب‌وکار
          مشترک است و نیازی به کپی ندارد.
        </p>
        <div className="mt-3">
          <PrimaryButton onClick={createBranch} disabled={busy || !name.trim()}>
            {busy ? "در حال ایجاد…" : "ایجاد شعبه"}
          </PrimaryButton>
        </div>
      </SectionCard>
    </div>
  );
}
