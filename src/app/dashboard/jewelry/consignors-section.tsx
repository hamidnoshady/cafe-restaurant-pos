"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { api, Field, inputClass } from "../ui";
import type { Consignor, Runner } from "./jewelry-manager";
import { cardClass } from "../page-chrome";

const jewelryInputClass = `${inputClass} min-h-[52px] !border-stone-200 !bg-card shadow-none placeholder:text-stone-400 focus-visible:border-amber-500 focus-visible:ring-amber-400/30`;

export function ConsignorsSection({
  consignors,
  busy,
  run,
}: {
  consignors: Consignor[];
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await run(() =>
      api("/api/jewelry/consignors", {
        method: "POST",
        body: JSON.stringify({ name, phone: phone.trim() || null, notes: notes.trim() || null }),
      }),
    );
    if (ok) {
      setName("");
      setPhone("");
      setNotes("");
    }
  }

  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1fr)_18rem] lg:gap-5 lg:grid-cols-[minmax(0,1fr)_21rem]">
      <section
        aria-labelledby="jewelry-consignors-heading"
        className={`order-2 min-w-0 overflow-hidden ${cardClass} md:order-1`}
      >
        <div className="border-b border-stone-200/80 px-4 py-4 sm:px-5">
          <h2 id="jewelry-consignors-heading" className="font-semibold text-stone-950">
            امانت‌گذاران (امانی)
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            صاحبان کالاهای امانی -- کالایی که فروشگاه مالک آن نیست، فقط برای فروش نگهداری می‌کند.
          </p>
        </div>

        <ul className="divide-y divide-stone-200/80">
          {consignors.map((c) => (
            <li key={c.id} className="px-4 py-4 sm:px-5">
              <h3 className="font-semibold text-stone-950">{c.name}</h3>
              <dl className="mt-2 grid gap-x-5 gap-y-1 text-xs text-stone-600 sm:grid-cols-2">
                {c.phone ? (
                  <div>
                    <dt className="inline text-stone-500">تلفن: </dt>
                    <dd className="inline font-medium text-stone-700" dir="ltr">
                      {c.phone}
                    </dd>
                  </div>
                ) : null}
                {c.notes ? (
                  <div>
                    <dt className="inline text-stone-500">یادداشت: </dt>
                    <dd className="inline font-medium text-stone-700">{c.notes}</dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
          {consignors.length === 0 ? (
            <li className="px-4 py-5 text-sm text-muted-foreground sm:px-5">امانت‌گذاری ثبت نشده است.</li>
          ) : null}
        </ul>
      </section>

      <aside className="order-1 min-w-0 md:order-2">
        <div className={`${cardClass} p-4 md:sticky md:top-4 sm:p-5`}>
          <h2 className="font-semibold text-stone-950">افزودن امانت‌گذار</h2>

          <form onSubmit={add} className="mt-4">
            <Field label="نام">
              <input
                className={jewelryInputClass}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </Field>
            <Field label="تلفن">
              <input
                className={jewelryInputClass}
                dir="ltr"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Field label="یادداشت">
              <input
                className={jewelryInputClass}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="اختیاری"
              />
            </Field>
            <Button
              type="submit"
              disabled={busy}
              size="lg"
              className="min-h-[52px] w-full border border-amber-300 px-5 font-semibold focus-visible:ring-amber-400/30"
            >
              افزودن
            </Button>
          </form>
        </div>
      </aside>
    </div>
  );
}
