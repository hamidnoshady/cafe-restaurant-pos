"use client";

import { useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, errorMessage, Field, inputClass, InfoBox, PrimaryButton, SecondaryButton } from "../ui";
import { ArStatementPanel } from "../ledger/ar-statement-panel";

interface Customer {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
  notes: string | null;
  isActive: boolean;
  createdAt: string;
}

interface CustomerBalance {
  customerId: string;
  balance: number;
}

const PAGE_SIZE = 20;

export function CustomersManager({ role }: { role: string }) {
  // The AR balance list and per-customer statement are guarded server-side
  // by requireRole("owner","manager","accountant") — cashiers manage the
  // directory but don't see accounting figures.
  const canSeeLedger = role === "owner" || role === "manager" || role === "accountant";

  const money = useMoney();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [page, setPage] = useState(1);
  const [refreshKey, setRefreshKey] = useState(0);

  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Customer | null>(null);
  const [statementTarget, setStatementTarget] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => setPage(1), [query, includeInactive]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
        ...(query.trim() ? { q: query.trim() } : {}),
        ...(includeInactive ? { includeInactive: "1" } : {}),
      });
      api<{ customers: Customer[]; total: number }>(`/api/customers?${params}`).then(({ ok, data }) => {
        if (ok) {
          setCustomers(data.customers);
          setTotal(data.total);
        }
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [query, includeInactive, page, refreshKey]);

  useEffect(() => {
    if (!canSeeLedger) return;
    api<{ customers: CustomerBalance[] }>("/api/ledger/ar/customers").then(({ ok, data }) => {
      if (ok) setBalances(Object.fromEntries(data.customers.map((c) => [c.customerId, c.balance])));
    });
  }, [canSeeLedger, refreshKey]);

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

  async function toggleActive(customer: Customer) {
    setInfo("");
    await run(() =>
      api(`/api/customers/${customer.id}`, {
        method: "PUT",
        body: JSON.stringify({ isActive: !customer.isActive }),
      }),
    );
  }

  async function remove(customer: Customer) {
    if (!window.confirm(`آیا از حذف «${customer.name}» مطمئن هستید؟`)) return;
    setInfo("");
    setError("");
    setBusy(true);
    const { ok, data } = await api<{ result?: "deleted" | "archived"; error?: string }>(
      `/api/customers/${customer.id}`,
      { method: "DELETE" },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo(
      data.result === "archived"
        ? "این مشتری سابقهٔ مالی دارد؛ برای حفظ صورتحساب‌ها به‌جای حذف، آرشیو شد."
        : "مشتری حذف شد.",
    );
    setRefreshKey((k) => k + 1);
  }

  const totalPages = Math.max(Math.ceil(total / PAGE_SIZE), 1);

  return (
    <section className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <div className="rounded-2xl bg-card p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              className={`${inputClass} w-56`}
              placeholder="جستجو با نام یا تلفن…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} />
              نمایش آرشیوشده‌ها
            </label>
          </div>
          <PrimaryButton type="button" onClick={() => setShowAdd(true)}>
            + مشتری جدید
          </PrimaryButton>
        </div>

        {!customers ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="py-2 pe-3 text-start">نام</th>
                  <th className="py-2 pe-3 text-start">تلفن</th>
                  <th className="py-2 pe-3 text-start">آدرس</th>
                  {canSeeLedger ? <th className="py-2 pe-3 text-start">مانده حساب</th> : null}
                  <th className="py-2 pe-3 text-start">وضعیت</th>
                  <th className="py-2 text-start">عملیات</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.id} className="border-b border-border">
                    <td className="py-2 pe-3 font-medium">
                      {canSeeLedger ? (
                        <button type="button" onClick={() => setStatementTarget({ id: c.id, name: c.name })} className="hover:underline">
                          {c.name}
                        </button>
                      ) : (
                        c.name
                      )}
                    </td>
                    <td className="py-2 pe-3 text-muted-foreground">{c.phone ? toPersianDigits(c.phone) : "—"}</td>
                    <td className="py-2 pe-3 text-muted-foreground">{c.address || "—"}</td>
                    {canSeeLedger ? (
                      <td className="py-2 pe-3 tabular-nums font-semibold">
                        {balances[c.id] ? money.format(balances[c.id]) : "—"}
                      </td>
                    ) : null}
                    <td className="py-2 pe-3">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${c.isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                      >
                        {c.isActive ? "فعال" : "آرشیو"}
                      </span>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        <button
                          type="button"
                          onClick={() => setEditTarget(c)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10"
                        >
                          ویرایش
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => toggleActive(c)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted"
                        >
                          {c.isActive ? "آرشیو" : "فعال‌سازی"}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => remove(c)}
                          className="rounded-lg px-2 py-1 text-xs font-semibold text-destructive hover:bg-destructive/10"
                        >
                          حذف
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {customers.length === 0 ? (
                  <tr>
                    <td colSpan={canSeeLedger ? 6 : 5} className="py-4 text-center text-muted-foreground">
                      مشتری‌ای پیدا نشد.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>

            {totalPages > 1 ? (
              <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {toPersianDigits(String(page))} از {toPersianDigits(String(totalPages))}
                </span>
                <div className="flex gap-2">
                  <SecondaryButton onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={page <= 1}>
                    قبلی
                  </SecondaryButton>
                  <SecondaryButton onClick={() => setPage((p) => Math.min(p + 1, totalPages))} disabled={page >= totalPages}>
                    بعدی
                  </SecondaryButton>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {showAdd ? (
        <CustomerFormDialog
          title="مشتری جدید"
          busy={busy}
          onClose={() => setShowAdd(false)}
          onSubmit={async (body) => {
            const ok = await run(() => api("/api/customers", { method: "POST", body: JSON.stringify(body) }));
            if (ok) setShowAdd(false);
            return ok;
          }}
        />
      ) : null}

      {editTarget ? (
        <CustomerFormDialog
          title={`ویرایش ${editTarget.name}`}
          initial={editTarget}
          busy={busy}
          onClose={() => setEditTarget(null)}
          onSubmit={async (body) => {
            const ok = await run(() => api(`/api/customers/${editTarget.id}`, { method: "PUT", body: JSON.stringify(body) }));
            if (ok) setEditTarget(null);
            return ok;
          }}
        />
      ) : null}

      {statementTarget ? (
        <ArStatementPanel
          customerId={statementTarget.id}
          customerName={statementTarget.name}
          onClose={() => setStatementTarget(null)}
        />
      ) : null}
    </section>
  );
}

function CustomerFormDialog({
  title,
  initial,
  busy,
  onClose,
  onSubmit,
}: {
  title: string;
  initial?: { name: string; phone: string | null; address: string | null; notes: string | null };
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: { name: string; phone?: string; address?: string; notes?: string }) => Promise<boolean>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [localError, setLocalError] = useState("");

  async function submit() {
    if (!name.trim()) {
      setLocalError(errorMessage("name_required"));
      return;
    }
    setLocalError("");
    await onSubmit({ name: name.trim(), phone: phone.trim(), address: address.trim(), notes: notes.trim() });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 font-semibold">{title}</h3>
        <ErrorBox>{localError}</ErrorBox>
        <Field label="نام">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="تلفن (اختیاری)">
          <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </Field>
        <Field label="آدرس (اختیاری)">
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="یادداشت (اختیاری)">
          <textarea className={inputClass} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="mt-4 flex justify-end gap-2">
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <PrimaryButton type="button" onClick={submit} disabled={busy}>
            ذخیره
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
