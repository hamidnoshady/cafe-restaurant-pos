"use client";

import { useCallback, useEffect, useState } from "react";
import { canTransitionDelivery, deliveryStatusLabel, type DeliveryStatus } from "@/lib/delivery";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { useRealtime } from "../use-realtime";

interface Delivery {
  id: string;
  order_id: string;
  order_number: number;
  order_status: string;
  order_total: string;
  status: DeliveryStatus;
  courier_id: string | null;
  courier_name: string | null;
  address: string;
  phone: string | null;
  fee: string;
  note: string | null;
  dispatched_at: string | null;
  delivered_at: string | null;
  opened_at: string;
}
interface Courier {
  id: string;
  name: string;
  phone: string | null;
  is_active: boolean;
}

const STATUS_STYLES: Record<DeliveryStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  assigned: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
  out_for_delivery: "bg-primary/15 text-primary",
  delivered: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  failed: "bg-destructive/15 text-destructive",
};

export function DeliveryBoard({ canManageCouriers }: { canManageCouriers: boolean }) {
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [couriers, setCouriers] = useState<Courier[]>([]);
  const [includeDone, setIncludeDone] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [dRes, cRes] = await Promise.all([
      api<{ deliveries: Delivery[] }>(`/api/deliveries?includeDone=${includeDone}`),
      api<{ couriers: Courier[] }>(`/api/couriers${canManageCouriers ? "?includeInactive=true" : ""}`),
    ]);
    if (dRes.ok) setDeliveries(dRes.data.deliveries);
    if (cRes.ok) setCouriers(cRes.data.couriers);
    setLoading(false);
  }, [includeDone, canManageCouriers]);

  useEffect(() => {
    load();
  }, [load]);

  useRealtime((event) => {
    if (event.type === "order.created" || event.type === "order.updated") load();
  });

  const activeCouriers = couriers.filter((c) => c.is_active);

  async function patch(id: string, body: Record<string, unknown>) {
    setError("");
    const { ok, data } = await api<{ error?: string }>(`/api/deliveries/${id}`, { method: "PATCH", body: JSON.stringify(body) });
    if (!ok) return setError(errorMessage(data.error));
    load();
  }

  const assign = (id: string, courierId: string) => patch(id, { action: "assign", courierId: courierId || null });
  const transition = (id: string, status: DeliveryStatus) => patch(id, { action: "status", status });

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
      <section>
        <div className="mb-4 flex items-center justify-between">
          <ErrorBox>{error}</ErrorBox>
          <label className="ms-auto flex items-center gap-2 text-sm text-muted-foreground">
            <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
            نمایش تحویل‌شده‌ها
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : deliveries.length === 0 ? (
          <p className="rounded-2xl bg-card p-8 text-center text-sm text-muted-foreground shadow-sm">
            سفارش ارسالی فعالی وجود ندارد.
          </p>
        ) : (
          <ul className="space-y-3">
            {deliveries.map((d) => (
              <li key={d.id} className="rounded-2xl bg-card p-4 shadow-sm">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-bold">{toPersianDigits(formatQueueLabel("delivery", d.order_number))}</p>
                    <p className="text-sm text-muted-foreground">{d.address}</p>
                    {d.phone ? <p className="text-xs text-muted-foreground" dir="ltr">{d.phone}</p> : null}
                  </div>
                  <div className="text-end">
                    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs ${STATUS_STYLES[d.status]}`}>
                      {deliveryStatusLabel(d.status)}
                    </span>
                    <p className="mt-1 text-sm">{formatToman(Number(d.order_total))}</p>
                    {Number(d.fee) > 0 ? (
                      <p className="text-xs text-muted-foreground">ارسال: {formatToman(Number(d.fee))}</p>
                    ) : null}
                  </div>
                </div>

                {d.status !== "delivered" && d.status !== "failed" ? (
                  <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                    <select
                      className={`${inputClass} w-auto`}
                      value={d.courier_id ?? ""}
                      onChange={(e) => assign(d.id, e.target.value)}
                    >
                      <option value="">— انتخاب پیک —</option>
                      {activeCouriers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    {canTransitionDelivery(d.status, "out_for_delivery") ? (
                      <SecondaryButton onClick={() => transition(d.id, "out_for_delivery")} disabled={!d.courier_id}>
                        اعزام پیک
                      </SecondaryButton>
                    ) : null}
                    {canTransitionDelivery(d.status, "delivered") ? (
                      <PrimaryButton type="button" onClick={() => transition(d.id, "delivered")}>
                        تحویل شد
                      </PrimaryButton>
                    ) : null}
                    {canTransitionDelivery(d.status, "failed") ? (
                      <button
                        type="button"
                        onClick={() => transition(d.id, "failed")}
                        className="text-xs text-destructive hover:underline"
                      >
                        ناموفق
                      </button>
                    ) : null}
                  </div>
                ) : (
                  <p className="border-t pt-3 text-xs text-muted-foreground">
                    {d.courier_name ? `پیک: ${d.courier_name}` : "بدون پیک"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManageCouriers ? <CourierPanel couriers={couriers} onChanged={load} /> : null}
    </div>
  );
}

function CourierPanel({ couriers, onChanged }: { couriers: Courier[]; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    setError("");
    if (!name.trim()) return setError("نام پیک را وارد کنید.");
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>("/api/couriers", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));
    setName("");
    setPhone("");
    onChanged();
  }

  async function toggle(id: string, isActive: boolean) {
    await api(`/api/couriers/${id}`, { method: "PATCH", body: JSON.stringify({ isActive }) });
    onChanged();
  }

  return (
    <aside className="h-fit rounded-2xl bg-card p-4 shadow-sm">
      <h2 className="mb-3 font-semibold">پیک‌ها</h2>
      <ErrorBox>{error}</ErrorBox>
      <div className="mb-4 space-y-2">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام پیک" />
        <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="تلفن (اختیاری)" />
        <PrimaryButton type="button" onClick={add} disabled={busy}>
          افزودن پیک
        </PrimaryButton>
      </div>
      <ul className="space-y-1 text-sm">
        {couriers.length === 0 ? <li className="text-muted-foreground">پیکی ثبت نشده است.</li> : null}
        {couriers.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-muted">
            <span className={c.is_active ? "" : "text-muted-foreground/60 line-through"}>{c.name}</span>
            <button
              type="button"
              onClick={() => toggle(c.id, !c.is_active)}
              className="text-xs text-muted-foreground hover:text-primary"
            >
              {c.is_active ? "غیرفعال" : "فعال"}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
