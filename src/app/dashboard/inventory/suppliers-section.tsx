"use client";

import { useState } from "react";
import { api, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import type { Runner, Supplier } from "./inventory-manager";

export function SuppliersSection({ suppliers, busy, run }: { suppliers: Supplier[]; busy: boolean; run: Runner }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await run(() =>
      api("/api/inventory/suppliers", { method: "POST", body: JSON.stringify({ name, phone }) }),
    );
    if (ok) {
      setName("");
      setPhone("");
    }
  }

  return (
    <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">تأمین‌کنندگان</h2>
      <form onSubmit={add} className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="نام تأمین‌کننده">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="تلفن">
          <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="اختیاری" />
        </Field>
        <div className="mb-4 flex items-end">
          <PrimaryButton disabled={busy}>افزودن</PrimaryButton>
        </div>
      </form>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {suppliers.map((s) => (
          <SupplierRow key={s.id} supplier={s} busy={busy} run={run} />
        ))}
        {suppliers.length === 0 ? <li className="p-3 text-sm text-muted-foreground">تأمین‌کننده‌ای ثبت نشده است.</li> : null}
      </ul>
    </section>
  );
}

function SupplierRow({ supplier: s, busy, run }: { supplier: Supplier; busy: boolean; run: Runner }) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return <EditSupplierRow supplier={s} busy={busy} run={run} onDone={() => setEditing(false)} />;
  }

  return (
    <li className="flex min-w-0 flex-col gap-3 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span className={`min-w-0 break-words ${s.is_active ? "" : "text-muted-foreground line-through"}`}>
        {s.name} {s.phone ? <span className="text-xs text-muted-foreground">({s.phone})</span> : null}
        {s.notes ? <span className="block text-xs text-muted-foreground">{s.notes}</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <SecondaryButton disabled={busy} onClick={() => setEditing(true)}>
          ویرایش
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`/api/inventory/suppliers/${s.id}`, {
                method: "PATCH",
                body: JSON.stringify({ isActive: !s.is_active }),
              }),
            )
          }
        >
          {s.is_active ? "غیرفعال" : "فعال"}
        </SecondaryButton>
      </div>
    </li>
  );
}

function EditSupplierRow({
  supplier: s,
  busy,
  run,
  onDone,
}: {
  supplier: Supplier;
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const [name, setName] = useState(s.name);
  const [phone, setPhone] = useState(s.phone ?? "");
  const [notes, setNotes] = useState(s.notes ?? "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await run(() =>
      api(`/api/inventory/suppliers/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, phone: phone.trim() || null, notes: notes.trim() || null }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="px-4 py-3">
      <form onSubmit={save} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <Field label="نام تأمین‌کننده">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
        </Field>
        <Field label="تلفن">
          <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="اختیاری" />
        </Field>
        <Field label="یادداشت">
          <input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="اختیاری" />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2 xl:col-span-3 sm:flex-row">
          <div className="w-full sm:w-40">
            <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          </div>
          <SecondaryButton disabled={busy} onClick={onDone}>
            انصراف
          </SecondaryButton>
        </div>
      </form>
    </li>
  );
}
