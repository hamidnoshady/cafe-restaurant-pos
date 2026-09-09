"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { api, Field, inputClass } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { InventoryItem, Runner } from "./inventory-manager";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";

interface Transfer {
  id: string;
  status: "draft" | "shipped" | "received" | "cancelled";
  note: string | null;
  created_at: string;
  shipped_at: string | null;
  received_at: string | null;
  cancelled_at: string | null;
  source_location_name: string;
  destination_location_name: string;
  line_count: number;
}

interface Location {
  id: string;
  name: string;
}

const STATUS_LABELS: Record<Transfer["status"], string> = {
  draft: "پیش‌نویس",
  shipped: "ارسال‌شده",
  received: "دریافت‌شده",
  cancelled: "لغوشده",
};

const STATUS_TONES: Record<Transfer["status"], "active" | "positive" | "neutral" | "danger"> = {
  draft: "active",
  shipped: "active",
  received: "positive",
  cancelled: "neutral",
};

export function TransfersSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const [transfers, setTransfers] = useState<Transfer[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);

  const loadTransfers = useCallback(() => {
    api<{ transfers: Transfer[] }>("/api/inventory/transfers").then(({ ok, data }) => {
      if (ok) setTransfers(data.transfers);
    });
  }, []);

  useEffect(() => {
    loadTransfers();
    api<{ locations: Location[] }>("/api/locations/active").then(({ ok, data }) => {
      if (ok) setLocations(data.locations ?? []);
    });
  }, [loadTransfers]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <TransferForm items={items} locations={locations} busy={busy} run={run} onCreated={loadTransfers} />
      <TransferList transfers={transfers} busy={busy} run={run} onChanged={loadTransfers} />
    </div>
  );
}

interface TransferLine {
  sourceItemId: string;
  destinationItemId: string;
  quantity: string;
}

function TransferForm({
  items,
  locations,
  busy,
  run,
  onCreated,
}: {
  items: InventoryItem[];
  locations: Location[];
  busy: boolean;
  run: Runner;
  onCreated: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [destId, setDestId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<TransferLine[]>([{ sourceItemId: "", destinationItemId: "", quantity: "" }]);

  const locationOptions = useMemo(() => [
    { value: "", label: "شعبه را انتخاب کنید…" },
    ...locations.map((l) => ({ value: l.id, label: l.name })),
  ], [locations]);

  const sourceItems = useMemo(() =>
    items.filter((i) => i.is_active && i.stock > 0),
    [items]);
  const destItems = useMemo(() =>
    items.filter((i) => i.is_active),
    [items]);

  const sourceItemOptions = useMemo(() => [
    { value: "", label: "قلم انبار مبدأ…" },
    ...sourceItems.map((i) => ({
      value: i.id,
      label: `${i.name} (${formatQuantity(i.stock)} ${i.unit})`,
      searchString: [i.name, i.sku].filter(Boolean).join(" "),
    })),
  ], [sourceItems]);

  const destItemOptions = useMemo(() => [
    { value: "", label: "قلم انبار مقصد…" },
    ...destItems.map((i) => ({
      value: i.id,
      label: `${i.name} (${i.unit})`,
      searchString: [i.name, i.sku].filter(Boolean).join(" "),
    })),
  ], [destItems]);

  function updateLine(index: number, patch: Partial<TransferLine>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { sourceItemId: "", destinationItemId: "", quantity: "" }]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceId || !destId || sourceId === destId) return;
    const validLines = lines.filter((l) => l.sourceItemId && l.destinationItemId && l.quantity.trim());
    if (validLines.length === 0) return;

    const ok = await run(() =>
      api("/api/inventory/transfers", {
        method: "POST",
        body: JSON.stringify({
          sourceLocationId: sourceId,
          destinationLocationId: destId,
          note: note.trim() || null,
          idempotencyKey: `transfer-${Date.now()}`,
          lines: validLines.map((l) => ({
            sourceInventoryItemId: l.sourceItemId,
            destinationInventoryItemId: l.destinationItemId,
            quantity: l.quantity,
          })),
        }),
      }),
    );
    if (ok) {
      setNote("");
      setLines([{ sourceItemId: "", destinationItemId: "", quantity: "" }]);
      onCreated();
    }
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">عملیات انتقال</p>
          <h2 className="mt-1 font-semibold text-foreground">ثبت انتقال بین انبارها</h2>
        </div>
      }
      description="مواد اولیه را بین شعب جابه‌جا کنید؛ پس از ثبت، ابتدا «ارسال» و سپس «دریافت» ثبت می‌شود."
    >
      <form onSubmit={submit} className="space-y-4">
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Field label="انبار مبدأ">
            <SearchableSelect value={sourceId} onChange={setSourceId} options={locationOptions} />
          </Field>
          <Field label="انبار مقصد">
            <SearchableSelect value={destId} onChange={setDestId} options={locationOptions} />
          </Field>
          <Field label="یادداشت">
            <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} placeholder="اختیاری" />
          </Field>
        </div>

        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="grid min-w-0 gap-3 rounded-xl border border-border/80 p-3 sm:grid-cols-2 xl:grid-cols-4">
              <Field label="قلم مبدأ">
                <SearchableSelect
                  value={line.sourceItemId}
                  onChange={(v) => updateLine(i, { sourceItemId: v })}
                  options={sourceItemOptions}
                />
              </Field>
              <Field label="قلم مقصد">
                <SearchableSelect
                  value={line.destinationItemId}
                  onChange={(v) => updateLine(i, { destinationItemId: v })}
                  options={destItemOptions}
                />
              </Field>
              <Field label="مقدار">
                <PersianNumberInput
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                />
              </Field>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => removeLine(i)}
                  disabled={lines.length === 1}
                >
                  حذف ردیف
                </Button>
              </div>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={addLine}>
            افزودن ردیف
          </Button>
          <Button type="submit" disabled={busy || !sourceId || !destId || sourceId === destId} size="lg" className="w-full px-5 font-semibold sm:w-52">
            ثبت انتقال
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

function TransferList({
  transfers,
  busy,
  run,
  onChanged,
}: {
  transfers: Transfer[] | null;
  busy: boolean;
  run: Runner;
  onChanged: () => void;
}) {
  async function transition(id: string, action: "ship" | "receive" | "cancel") {
    const ok = await run(() =>
      api(`/api/inventory/transfers/${id}/${action}`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    if (ok) onChanged();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
          <h2 className="mt-1 font-semibold text-foreground">انتقال‌های اخیر</h2>
        </div>
      }
      flush
    >
      {transfers === null ? (
        <div className="p-4 sm:p-5">
          <LoadingSkeleton rows={4} label="در حال بارگذاری انتقال‌ها" />
        </div>
      ) : transfers.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState>هنوز انتقالی بین انبارها ثبت نشده است.</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border/80">
          {transfers.map((t) => (
            <li key={t.id} className="flex min-w-0 flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">
                    {t.source_location_name}
                    <span className="mx-1.5 text-muted-foreground">→</span>
                    {t.destination_location_name}
                  </span>
                  <StatusBadge tone={STATUS_TONES[t.status]}>
                    {STATUS_LABELS[t.status]}
                  </StatusBadge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {toPersianDigits(t.line_count)} قلم · {formatJalali(t.created_at)}
                  {t.note ? ` · ${t.note}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                {t.status === "draft" ? (
                  <>
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => transition(t.id, "ship")}>
                      ارسال
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={busy}
                      onClick={() => {
                        if (!window.confirm("این انتقال لغو شود؟")) return;
                        transition(t.id, "cancel");
                      }}
                    >
                      لغو
                    </Button>
                  </>
                ) : null}
                {t.status === "shipped" ? (
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => transition(t.id, "receive")}>
                    تأیید دریافت
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
