"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { TABLE_STATUS_LABELS, type TableStatus } from "@/lib/table-sessions";
import { useRealtime } from "../use-realtime";
import { api } from "../ui";
import { TableOrderPanel } from "./table-order-panel";

interface WaiterTable {
  id: string;
  name: string;
  section_id: string | null;
  capacity: number;
  status: TableStatus;
  session_id: string | null;
  party_size: number | null;
  guest_name: string | null;
  order_id: string | null;
  order_number: number | null;
  item_status_counts: Record<string, number>;
}
interface Section {
  id: string;
  name: string;
  color: string | null;
}

const STATUS_STYLE: Record<TableStatus, string> = {
  free: "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-200",
  seated: "border-primary bg-primary/10 text-primary",
  bill_requested: "border-purple-500 bg-purple-100 text-purple-900 dark:border-purple-500 dark:bg-purple-950 dark:text-purple-200",
  cleaning: "border-muted-foreground/40 bg-muted text-muted-foreground",
  out_of_service: "border-destructive/40 bg-destructive/5 text-destructive/80",
};

export function WaiterBoard() {
  const [sections, setSections] = useState<Section[]>([]);
  const [tables, setTables] = useState<WaiterTable[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(() => {
    api<{ sections: Section[]; tables: WaiterTable[] }>("/api/waiter/board").then(({ ok, data }) => {
      if (ok) {
        setSections(data.sections);
        setTables(data.tables);
      }
      setLoaded(true);
    });
  }, []);
  useEffect(load, [load]);

  useRealtime(
    useCallback(
      (event) => {
        if (["order.created", "order.updated", "order.item_status", "table.status", "table_session.updated"].includes(event.type)) {
          load();
        }
      },
      [load],
    ),
  );

  const selected = tables.find((t) => t.id === selectedId) ?? null;

  if (!loaded) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;
  if (selected) {
    return <TableOrderPanel table={selected} onBack={() => setSelectedId(null)} onChanged={load} />;
  }

  const bySection = new Map<string | null, WaiterTable[]>();
  for (const t of tables) {
    if (!bySection.has(t.section_id)) bySection.set(t.section_id, []);
    bySection.get(t.section_id)!.push(t);
  }

  if (tables.length === 0) {
    return <p className="text-sm text-muted-foreground">میزی به شما تخصیص داده نشده است.</p>;
  }

  return (
    <div className="space-y-6">
      {[...bySection.entries()].map(([sectionId, sectionTables]) => (
        <div key={sectionId ?? "none"}>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
            {sections.find((s) => s.id === sectionId)?.name ?? "بدون بخش"}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {sectionTables.map((t) => {
              const ready = t.item_status_counts.ready ?? 0;
              const cooking = (t.item_status_counts.sent ?? 0) + (t.item_status_counts.preparing ?? 0);
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setSelectedId(t.id)}
                  className={`rounded-2xl border-2 p-4 text-start shadow-sm transition hover:ring-2 hover:ring-ring/40 ${STATUS_STYLE[t.status]}`}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-bold">{t.name}</span>
                    {ready > 0 ? (
                      <span className="rounded-full bg-emerald-700 px-2 py-0.5 text-xs text-white dark:bg-emerald-600">
                        {toPersianDigits(ready)} آماده
                      </span>
                    ) : null}
                  </div>
                  <p className="text-xs">{TABLE_STATUS_LABELS[t.status]}</p>
                  {t.guest_name ? <p className="mt-1 text-xs">{t.guest_name}</p> : null}
                  {cooking > 0 ? <p className="mt-1 text-xs">{toPersianDigits(cooking)} قلم در حال آماده‌سازی</p> : null}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
