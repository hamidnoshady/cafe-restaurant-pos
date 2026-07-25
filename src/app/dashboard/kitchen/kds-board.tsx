"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2Icon, CircleIcon, FlameIcon } from "lucide-react";
import { KdsDarkDefault } from "@/components/kds-dark-default";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toPersianDigits } from "@/lib/digits";
import { formatQueueLabel } from "@/lib/orders";
import { DEFAULT_TICKET_AGING_MINUTES, ORDER_ITEM_STATUS_LABELS, ticketAgeMinutes } from "@/lib/order-item-status";
import { apiOrQueue } from "../offline-queue";
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
    const res = await apiOrQueue(
      `/api/kitchen/items/${itemId}`,
      { method: "PATCH", body: { status } },
      { type: "order_item.status", payload: { itemId, status }, description: "بروزرسانی وضعیت آشپزخانه" },
    );
    if (res.ok && !res.queued) load();
  }

  if (tickets.length === 0) {
    return (
      <>
        <KdsDarkDefault />
        <p className="text-sm text-muted-foreground">فعلاً سفارشی برای آشپزخانه نیست.</p>
      </>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      <KdsDarkDefault />
      {tickets.map((ticket) => {
        const age = ticketAgeMinutes(ticket.earliestSentAt, now);
        const late = age >= DEFAULT_TICKET_AGING_MINUTES;
        return (
          <div
            key={ticket.key}
            className={`rounded-2xl border-2 bg-card p-3 shadow-sm ${late ? "border-destructive/60" : "border-border"}`}
          >
            <div className="mb-3 flex items-center justify-between">
              <span className="font-bold text-primary">{toPersianDigits(ticket.label)}</span>
              <span className={`text-xs ${late ? "font-semibold text-destructive" : "text-muted-foreground"}`}>
                {toPersianDigits(Math.floor(age))} دقیقه پیش
              </span>
            </div>
            <ul className="space-y-3">
              {ticket.items.map((item) => {
                const next = NEXT_STATUS[item.status];
                const mods = modifiersByItem.get(item.id) ?? [];
                return (
                  <li key={item.id} className="border-t border-border pt-2 first:border-t-0 first:pt-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium">
                          {toPersianDigits(item.quantity)}× {item.name_snapshot}
                        </p>
                        {mods.length > 0 ? <p className="text-xs text-muted-foreground">{mods.join("، ")}</p> : null}
                        {item.note ? <p className="text-xs text-primary">{item.note}</p> : null}
                      </div>
                      <Badge
                        variant="outline"
                        className={`shrink-0 border-transparent transition-colors duration-300 ${
                          item.status === "ready"
                            ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                            : item.status === "preparing"
                              ? "bg-primary/10 text-primary"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {item.status === "ready" ? (
                          <CheckCircle2Icon />
                        ) : item.status === "preparing" ? (
                          <FlameIcon />
                        ) : (
                          <CircleIcon />
                        )}
                        {ORDER_ITEM_STATUS_LABELS[item.status]}
                      </Badge>
                    </div>
                    {next ? (
                      <Button
                        type="button"
                        size="lg"
                        onClick={() => bump(item.id, next)}
                        className="mt-2 w-full text-sm font-semibold"
                      >
                        {BUMP_LABEL[item.status]}
                      </Button>
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
