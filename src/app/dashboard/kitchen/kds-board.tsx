"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatQueueLabel } from "@/lib/orders";
import { DEFAULT_TICKET_AGING_MINUTES, ORDER_ITEM_STATUS_LABELS, ticketAgeMinutes } from "@/lib/order-item-status";
import { useRealtime } from "../use-realtime";
import { api } from "../ui";

interface TicketItem {
  id: string;
  order_id: string;
  name_snapshot: string;
  quantity: number;
  status: "sent" | "preparing" | "ready";
  note: string | null;
  sent_to_kitchen_at: string;
  order_type: "dine_in" | "takeaway" | "delivery";
  order_number: number;
  table_session_id: string | null;
  table_id: string | null;
  table_name: string | null;
}
interface Modifier {
  order_item_id: string;
  name_snapshot: string;
}

interface Ticket {
  key: string;
  label: string;
  earliestSentAt: number;
  items: TicketItem[];
}

const NEXT_STATUS: Record<TicketItem["status"], "preparing" | "ready" | null> = {
  sent: "preparing",
  preparing: "ready",
  ready: null,
};
const BUMP_LABEL: Record<TicketItem["status"], string> = {
  sent: "شروع پخت",
  preparing: "آماده شد",
  ready: "",
};

export function KdsBoard() {
  const [items, setItems] = useState<TicketItem[]>([]);
  const [modifiers, setModifiers] = useState<Modifier[]>([]);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(() => {
    api<{ items: TicketItem[]; modifiers: Modifier[] }>("/api/kitchen/tickets").then(({ ok, data }) => {
      if (ok) {
        setItems(data.items);
        setModifiers(data.modifiers);
      }
    });
  }, []);
  useEffect(load, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (["order.created", "order.updated", "order.item_status"].includes(event.type)) load();
      },
      [load],
    ),
  );

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const modifiersByItem = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const m of modifiers) {
      if (!map.has(m.order_item_id)) map.set(m.order_item_id, []);
      map.get(m.order_item_id)!.push(m.name_snapshot);
    }
    return map;
  }, [modifiers]);

  const tickets = useMemo<Ticket[]>(() => {
    const groups = new Map<string, TicketItem[]>();
    for (const item of items) {
      const key = item.table_session_id ?? item.order_id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(item);
    }
    return [...groups.entries()]
      .map(([key, groupItems]) => {
        const first = groupItems[0];
        const label =
          first.order_type === "dine_in"
            ? (first.table_name ?? formatQueueLabel(first.order_type, first.order_number))
            : formatQueueLabel(first.order_type, first.order_number);
        const earliestSentAt = Math.min(...groupItems.map((i) => new Date(i.sent_to_kitchen_at).getTime()));
        return { key, label, earliestSentAt, items: groupItems };
      })
      .sort((a, b) => a.earliestSentAt - b.earliestSentAt);
  }, [items]);

  async function bump(itemId: string, status: "preparing" | "ready") {
    const res = await api(`/api/kitchen/items/${itemId}`, { method: "PATCH", body: JSON.stringify({ status }) });
    if (res.ok) load();
  }

  if (tickets.length === 0) {
    return <p className="text-sm text-stone-400">فعلاً سفارشی برای آشپزخانه نیست.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {tickets.map((ticket) => {
        const age = ticketAgeMinutes(ticket.earliestSentAt, now);
        const late = age >= DEFAULT_TICKET_AGING_MINUTES;
        return (
          <div
            key={ticket.key}
            className={`rounded-2xl border-2 bg-white p-4 shadow-sm ${late ? "border-red-400" : "border-stone-200"}`}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-bold text-amber-700">{toPersianDigits(ticket.label)}</span>
              <span className={`text-xs ${late ? "font-semibold text-red-600" : "text-stone-400"}`}>
                {toPersianDigits(Math.floor(age))} دقیقه پیش
              </span>
            </div>
            <ul className="space-y-3">
              {ticket.items.map((item) => {
                const next = NEXT_STATUS[item.status];
                const mods = modifiersByItem.get(item.id) ?? [];
                return (
                  <li key={item.id} className="border-t border-stone-100 pt-2 first:border-t-0 first:pt-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {toPersianDigits(item.quantity)}× {item.name_snapshot}
                        </p>
                        {mods.length > 0 ? <p className="text-xs text-stone-500">{mods.join("، ")}</p> : null}
                        {item.note ? <p className="text-xs text-amber-700">{item.note}</p> : null}
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
                          item.status === "ready"
                            ? "bg-emerald-100 text-emerald-800"
                            : item.status === "preparing"
                              ? "bg-amber-100 text-amber-800"
                              : "bg-stone-100 text-stone-600"
                        }`}
                      >
                        {ORDER_ITEM_STATUS_LABELS[item.status]}
                      </span>
                    </div>
                    {next ? (
                      <button
                        type="button"
                        onClick={() => bump(item.id, next)}
                        className="mt-2 w-full rounded-lg bg-amber-600 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
                      >
                        {BUMP_LABEL[item.status]}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
