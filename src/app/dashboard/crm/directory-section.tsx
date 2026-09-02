"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The CRM app's customer directory (Phase 36).
 *
 * This is the old `/dashboard/customers` manager, moved into the app that now
 * owns the customer record. It is deliberately the *same* screen rather than a
 * rewrite: it was already the working CRUD surface the floor uses, and the
 * value of the move is that the record now sits next to its file, its notes,
 * its consent and its history instead of on a flat page beside حسابداری.
 *
 * What changed in the move: each row links into the customer's 360° file, and
 * the AR statement stays exactly where it was — the ledger's own panel, opened
 * for the members who may see accounting figures. The CRM reads that balance;
 * it does not restate it.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionCard, StatusBadge } from "../page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass, InfoBox } from "../ui";
import { ArStatementPanel } from "../ledger/ar-statement-panel";
import { crmCustomerHref } from "./crm-routes";

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

export function DirectorySection({ role }: { role: string }) {
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
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت مشتریان</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">فهرست مشتریان</h2>
          </div>
        }
        description="روی نام هر مشتری بزنید تا پروندهٔ کامل او باز شود."
        actions={
          <Button type="button" onClick={() => setShowAdd(true)}>
            + مشتری جدید
          </Button>
        }
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            className={`${inputClass} w-full sm:w-56`}
            placeholder="جستجو با نام یا تلفن…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeInactive}
              onCheckedChange={(checked) => setIncludeInactive(checked === true)}
            />
            نمایش آرشیوشده‌ها
          </label>
        </div>

        {!customers ? (
          <LoadingSkeleton rows={3} />
        ) : (
          <>
            <div className="hidden overflow-x-auto lg:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/80 text-muted-foreground">
                    <th className="py-2 pe-3 text-start font-medium">نام</th>
                    <th className="py-2 pe-3 text-start font-medium">تلفن</th>
                    <th className="py-2 pe-3 text-start font-medium">آدرس</th>
                    {canSeeLedger ? <th className="py-2 pe-3 text-start font-medium">مانده حساب</th> : null}
                    <th className="py-2 pe-3 text-start font-medium">وضعیت</th>
                    <th className="py-2 text-start font-medium">عملیات</th>
                  </tr>
                </thead>
                <tbody>
                  {customers.map((c) => (
                    <tr key={c.id} className="border-b border-border/80 transition-colors hover:bg-stone-50/70 dark:hover:bg-muted/50">
                      <td className="py-3 pe-3 font-medium text-foreground">
                        <Link href={crmCustomerHref(c.id)} className="hover:underline">
                          {c.name}
                        </Link>
                      </td>
                      <td className="py-3 pe-3 text-muted-foreground">{c.phone ? toPersianDigits(c.phone) : "—"}</td>
                      <td className="py-3 pe-3 text-muted-foreground">{c.address || "—"}</td>
                      {canSeeLedger ? (
                        <td className="py-3 pe-3 tabular-nums font-semibold">
                          {balances[c.id] ? money.format(balances[c.id]) : "—"}
                        </td>
                      ) : null}
                      <td className="py-3 pe-3">
                        <StatusBadge tone={c.isActive ? "positive" : "neutral"}>
                          {c.isActive ? "فعال" : "آرشیو"}
                        </StatusBadge>
                      </td>
                      <td className="py-3">
                        <div className="flex flex-wrap gap-1">
                          <Button type="button" variant="ghost" size="xs" onClick={() => setEditTarget(c)}>
                            ویرایش
                          </Button>
                          {canSeeLedger ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() => setStatementTarget({ id: c.id, name: c.name })}
                              className="text-muted-foreground"
                            >
                              صورتحساب
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => toggleActive(c)}
                            className="text-muted-foreground"
                          >
                            {c.isActive ? "آرشیو" : "فعال‌سازی"}
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="xs"
                            disabled={busy}
                            onClick={() => remove(c)}
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            حذف
                          </Button>
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
            </div>

            <div className="space-y-3 lg:hidden">
              {customers.map((c) => (
                <div key={c.id} className="rounded-xl border border-border/80 bg-muted/50 p-4 transition-colors hover:bg-muted">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <Link href={crmCustomerHref(c.id)} className="font-semibold text-foreground hover:underline">
                        {c.name}
                      </Link>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.phone ? toPersianDigits(c.phone) : "بدون تلفن"} · {c.address || "بدون آدرس"}
                      </p>
                    </div>
                    <StatusBadge tone={c.isActive ? "positive" : "neutral"}>
                      {c.isActive ? "فعال" : "آرشیو"}
                    </StatusBadge>
                  </div>
                  {canSeeLedger && balances[c.id] ? (
                    <p className="mt-2 text-xs font-semibold text-foreground">
                      مانده حساب: {money.format(balances[c.id])}
                    </p>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/80 pt-2">
                    <Button type="button" variant="ghost" size="xs" onClick={() => setEditTarget(c)}>
                      ویرایش
                    </Button>
                    {canSeeLedger ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        onClick={() => setStatementTarget({ id: c.id, name: c.name })}
                        className="text-muted-foreground"
                      >
                        صورتحساب
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => toggleActive(c)}
                      className="text-muted-foreground"
                    >
                      {c.isActive ? "آرشیو" : "فعال‌سازی"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      disabled={busy}
                      onClick={() => remove(c)}
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      حذف
                    </Button>
                  </div>
                </div>
              ))}
              {customers.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">مشتری‌ای پیدا نشد.</p>
              ) : null}
            </div>

            {totalPages > 1 ? (
              <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  {toPersianDigits(String(page))} از {toPersianDigits(String(totalPages))}
                </span>
                <div className="flex gap-2">
                  <Button type="button" variant="outline" onClick={() => setPage((p) => Math.max(p - 1, 1))} disabled={page <= 1}>
                    قبلی
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setPage((p) => Math.min(p + 1, totalPages))} disabled={page >= totalPages}>
                    بعدی
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </SectionCard>

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
    </div>
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
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{localError}</ErrorBox>
        <Field label="نام">
          <input className={inputClass} maxLength={200} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="تلفن (اختیاری)">
          <input
            className={inputClass}
            dir="ltr"
            maxLength={32}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
        <Field label="آدرس (اختیاری)">
          <input className={inputClass} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="یادداشت (اختیاری)">
          <textarea
            className={inputClass}
            rows={2}
            maxLength={2000}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
