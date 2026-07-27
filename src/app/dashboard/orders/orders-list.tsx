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

  if (!orders) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  if (orders.length === 0) return <p className="text-sm text-muted-foreground">سفارش بازی وجود ندارد.</p>;

  return (
    <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
      {orders.map((o) => (
        <Link
          key={o.id}
          href={`/dashboard/orders/${o.id}`}
          className="group rounded-xl border border-border/80 bg-card p-3 shadow-[0_1px_3px_rgb(15_23_42/0.04)] transition-all hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_4px_10px_rgb(15_23_42/0.06)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="mb-2 flex items-center justify-between border-b border-border/70 pb-2">
            <span className="font-bold text-primary">{toPersianDigits(formatQueueLabel(o.type, o.order_number))}</span>
            <span className="text-xs text-muted-foreground">{o.type === "dine_in" ? "حضوری" : "بیرون‌بر"}</span>
          </div>
          {o.table_name ? <p className="text-sm text-muted-foreground">{o.table_name}</p> : null}
          <p className="mt-2 text-sm font-medium">{formatToman(Number(o.total))}</p>
        </Link>
      ))}
    </div>
  );
}
