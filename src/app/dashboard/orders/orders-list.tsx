"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { formatQueueLabel } from "@/lib/orders";
import { useRealtime } from "../use-realtime";
import { api } from "../ui";

interface OpenOrder {
  id: string;
  order_number: number;
  type: "dine_in" | "takeaway" | "delivery";
  table_name: string | null;
  guest_count: number | null;
  total: string | number;
  opened_at: string;
}

export function OrdersList() {
  const [orders, setOrders] = useState<OpenOrder[] | null>(null);

  const load = useCallback(() => {
    api<{ orders: OpenOrder[] }>("/api/orders").then(({ ok, data }) => {
      if (ok) setOrders(data.orders);
    });
  }, []);
  useEffect(load, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (["order.created", "order.updated"].includes(event.type)) load();
      },
      [load],
    ),
  );

  if (!orders) return <p className="text-sm text-stone-400">در حال بارگذاری…</p>;
  if (orders.length === 0) return <p className="text-sm text-stone-400">سفارش بازی وجود ندارد.</p>;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {orders.map((o) => (
        <Link
          key={o.id}
          href={`/dashboard/orders/${o.id}`}
          className="rounded-2xl bg-white p-4 shadow-sm transition hover:ring-2 hover:ring-amber-200"
        >
          <div className="mb-1 flex items-center justify-between">
            <span className="font-bold text-amber-700">{toPersianDigits(formatQueueLabel(o.type, o.order_number))}</span>
            <span className="text-xs text-stone-400">{o.type === "dine_in" ? "حضوری" : "بیرون‌بر"}</span>
          </div>
          {o.table_name ? <p className="text-sm text-stone-600">{o.table_name}</p> : null}
          <p className="mt-2 text-sm font-medium">{formatToman(Number(o.total))}</p>
        </Link>
      ))}
    </div>
  );
}
