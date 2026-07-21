"use client";

import { useState } from "react";
import { api, inputClass, PrimaryButton, SecondaryButton } from "../ui";
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
    <section className="rounded-2xl bg-white p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">تأمین‌کنندگان</h2>
      <form onSubmit={add} className="mb-4 flex flex-wrap gap-2">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام تأمین‌کننده" required />
        <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="تلفن (اختیاری)" />
        <PrimaryButton disabled={busy}>افزودن</PrimaryButton>
      </form>
      <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
        {suppliers.map((s) => (
          <li key={s.id} className="flex items-center justify-between px-4 py-2 text-sm">
            <span className={s.is_active ? "" : "text-stone-400 line-through"}>
              {s.name} {s.phone ? <span className="text-xs text-stone-400">({s.phone})</span> : null}
            </span>
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
          </li>
        ))}
        {suppliers.length === 0 ? <li className="p-3 text-sm text-stone-400">تأمین‌کننده‌ای ثبت نشده است.</li> : null}
      </ul>
    </section>
  );
}
