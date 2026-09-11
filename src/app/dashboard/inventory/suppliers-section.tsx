"use client";

/**
 * Inventory → تأمین‌کنندگان.
 *
 * Two things live here, and the split is the whole point of the change:
 *
 *  - **The supplier file** — who the counterparty is, their phone, their ledger
 *    code, their archive flag. That is the shared party record, and the store shows
 *    it through the same `PartiesSection` the CRM and Accounting use, in the
 *    `operations` scope (suppliers only, no ledger columns). Editing a supplier's
 *    name here edits the row the ledger pays, which is the only way the two stop
 *    disagreeing.
 *  - **This branch's alias** — `suppliers` keyed on `location_id`, which is what a
 *    purchase order points at. Whether *this* branch buys from that party, and the
 *    branch's own note about them, are genuinely per-location, so they stay here.
 *
 * The old screen had a name/phone form of its own writing `suppliers.name`
 * directly, and the party behind it (when there was one) never heard about the
 * edit. That form is gone: the identity fields are read-only here and refused by
 * `PATCH /api/inventory/suppliers/:id` on a linked row (`supplier_identity_on_party`),
 * so the drift is not possible in either direction.
 */
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { api, Field, inputClass } from "../ui";
import { partyScopeFor } from "@/lib/parties-scopes";
import { toPersianDigits } from "@/lib/digits";
import { EmptyState, LoadingSkeleton, SectionCard } from "../page-chrome";
import { PartiesSection } from "../parties/parties-section";
import type { Runner, Supplier } from "./inventory-manager";

export function SuppliersSection({
  suppliers,
  busy,
  run,
  role,
}: {
  suppliers: Supplier[];
  busy: boolean;
  run: Runner;
  role: string;
}) {
  return (
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <PartiesSection scope={partyScopeFor("operations")} role={role} />
      <BranchSupplierLinks suppliers={suppliers} busy={busy} run={run} />
    </div>
  );
}

interface PartyOption {
  id: string;
  name: string;
  phone?: string | null;
  accountingCode?: string | null;
}

function BranchSupplierLinks({
  suppliers,
  busy,
  run,
}: {
  suppliers: Supplier[];
  busy: boolean;
  run: Runner;
}) {
  const [linkQuery, setLinkQuery] = useState("");
  const [parties, setParties] = useState<PartyOption[] | null>(null);

  useEffect(() => {
    const params = new URLSearchParams({ roles: "Supplier", page: "1", pageSize: "100" });
    if (linkQuery.trim()) params.set("q", linkQuery.trim());
    void api<{ parties: PartyOption[] }>(`/api/parties?${params}`).then(({ ok, data }) => {
      setParties(ok ? data.parties ?? [] : []);
    });
  }, [linkQuery]);

  const linked = useMemo(() => new Set(suppliers.map((s) => s.partyId).filter(Boolean)), [suppliers]);

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">شعبه</p>
          <h2 className="mt-1 font-semibold text-foreground">تأمین‌کنندگان این شعبه</h2>
        </div>
      }
      description="خریدها به همین فهرست ثبت می‌شوند؛ نام و تلفن از پروندهٔ مشترک اشخاص خوانده می‌شود و اینجا فقط یادداشت و وضعیت فعال‌بودنِ همین شعبه است."
      flush
    >
      <ul className="divide-y divide-border/80">
        {suppliers.map((supplier) => (
          <BranchSupplierRow key={supplier.id} supplier={supplier} busy={busy} run={run} />
        ))}
        {suppliers.length === 0 ? (
          <li className="px-4 py-5 sm:px-5">
            <EmptyState>این شعبه هنوز تأمین‌کننده‌ای به نام خود ندارد.</EmptyState>
          </li>
        ) : null}
      </ul>

      <div className="border-t border-border/80 p-4 sm:p-5">
        <Field label="افزودن تأمین‌کننده به این شعبه">
          <input
            className={inputClass}
            value={linkQuery}
            onChange={(event) => setLinkQuery(event.target.value)}
            placeholder="جستجو در تأمین‌کنندگان…"
          />
        </Field>
        {parties === null ? (
          <div className="mt-2">
            <LoadingSkeleton rows={2} compact label="در حال بارگذاری تأمین‌کنندگان" />
          </div>
        ) : null}
        {parties && parties.length > 0 ? (
          <ul className="mt-2 divide-y divide-border/80 rounded-xl border border-border/80">
            {parties
              .filter((party) => !linked.has(party.id))
              .map((party) => (
                <li key={party.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 truncate">
                    {party.name}
                    {party.phone ? (
                      <span className="text-xs text-muted-foreground"> ({toPersianDigits(party.phone)})</span>
                    ) : null}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        api("/api/inventory/suppliers", { method: "POST", body: JSON.stringify({ partyId: party.id }) }),
                      )
                    }
                  >
                    افزودن به این شعبه
                  </Button>
                </li>
              ))}
          </ul>
        ) : null}
        {parties && parties.every((party) => linked.has(party.id)) ? (
          <p className="mt-2 text-xs text-muted-foreground">
            هر تأمین‌کننده‌ای که در پروندهٔ مشترک هست، به این شعبه هم پیوند خورده است.
          </p>
        ) : null}
        {parties && parties.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            تأمین‌کننده‌ای در اشخاص پیدا نشد؛ با دکمهٔ «افزودن تأمین‌کننده» در فهرست بالا یکی بسازید.
          </p>
        ) : null}
      </div>
    </SectionCard>
  );
}

function BranchSupplierRow({ supplier, busy, run }: { supplier: Supplier; busy: boolean; run: Runner }) {
  const [notes, setNotes] = useState(supplier.notes ?? "");
  const [editing, setEditing] = useState(false);
  const name = supplier.displayName || supplier.name;
  const phone = supplier.displayPhone || supplier.phone;

  return (
    <li className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className={`min-w-0 break-words ${supplier.is_active ? "" : "text-muted-foreground line-through"}`}>
        <span className="font-medium text-foreground">{name}</span>
        {phone ? <span className="text-xs text-muted-foreground"> ({toPersianDigits(phone)})</span> : null}
        {supplier.partyId ? null : (
          <span className="ms-2 rounded-full bg-amber-100 dark:bg-amber-500/20 px-2 py-0.5 text-xs text-amber-950 dark:text-amber-200">
            بدون پروندهٔ مشترک
          </span>
        )}
        {supplier.notes && !editing ? <span className="block text-xs text-muted-foreground">{supplier.notes}</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <div className="flex min-w-0 items-end gap-2">
            <div className="w-48">
              <Field label="یادداشت این شعبه">
                <input className={inputClass} value={notes} onChange={(event) => setNotes(event.target.value)} />
              </Field>
            </div>
            <Button
              disabled={busy}
              size="lg"
              className="px-5 font-semibold"
              onClick={async () => {
                const ok = await run(() =>
                  api(`/api/inventory/suppliers/${supplier.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ notes: notes.trim() || null }),
                  }),
                );
                if (ok) setEditing(false);
                else setNotes(supplier.notes ?? "");
              }}
            >
              ذخیره
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => {
                setNotes(supplier.notes ?? "");
                setEditing(false);
              }}
            >
              انصراف
            </Button>
          </div>
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => setEditing(true)}>
              یادداشت
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/inventory/suppliers/${supplier.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ isActive: !supplier.is_active }),
                  }),
                )
              }
            >
              {supplier.is_active ? "غیرفعال" : "فعال"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`«${name}» از این شعبه حذف شود؟ (پروندهٔ شخص در اشخاص دست‌نخورده می‌ماند.)`)) return;
                void run(() => api(`/api/inventory/suppliers/${supplier.id}`, { method: "DELETE" }));
              }}
            >
              حذف
            </Button>
          </>
        )}
      </div>
    </li>
  );
}
