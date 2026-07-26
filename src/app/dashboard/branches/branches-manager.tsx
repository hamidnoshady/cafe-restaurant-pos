"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { ErrorBox, Field, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";

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

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  const activeBranches = branches.filter((b) => b.isActive);

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>

      <section className="rounded-lg border p-4">
        <h2 className="mb-3 font-semibold">شعب</h2>
        <div className="space-y-2">
          {branches.map((branch) => (
            <div
              key={branch.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
            >
              <div>
                <p className="font-medium">
                  {branch.name}
                  {!branch.isActive && (
                    <span className="ms-2 rounded bg-muted px-2 py-0.5 text-xs">غیرفعال</span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {[branch.address, branch.phone].filter(Boolean).join(" · ") || "بدون آدرس/تلفن ثبت‌شده"}
                  {" · ایجاد "}
                  {toPersianDigits(formatJalali(new Date(branch.createdAt)))}
                </p>
              </div>
              <div className="flex gap-2">
                <SecondaryButton onClick={() => rename(branch)}>تغییر نام</SecondaryButton>
                <SecondaryButton onClick={() => toggleActive(branch)}>
                  {branch.isActive ? "غیرفعال‌سازی" : "فعال‌سازی"}
                </SecondaryButton>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-3 font-semibold">افزودن شعبهٔ جدید</h2>
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
            <select className={inputClass} value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">بدون کپی — منوی خالی</option>
              {activeBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          کپی فقط ساختار منو (دسته‌ها، آیتم‌ها و افزودنی‌ها) را شامل می‌شود؛ موجودی انبار، دستور پخت و
          چاپگرها منتقل نمی‌شوند، چون به‌صورت فیزیکی مختص هر شعبه‌اند. سرفصل حساب‌ها در کل کسب‌وکار
          مشترک است و نیازی به کپی ندارد.
        </p>
        <div className="mt-3">
          <PrimaryButton onClick={createBranch} disabled={busy || !name.trim()}>
            ایجاد شعبه
          </PrimaryButton>
        </div>
      </section>
    </div>
  );
}
