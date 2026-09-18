"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { api, Field, inputClass } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { Runner } from "./inventory-manager";
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

/** An item as it exists in one specific warehouse — from /api/inventory/location-items. */
interface LocationItem {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  is_active: boolean;
  stock: number;
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
  busy,
  run,
}: {
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
      <TransferForm locations={locations} busy={busy} run={run} onCreated={loadTransfers} />
      <TransferList transfers={transfers} busy={busy} run={run} onChanged={loadTransfers} />
    </div>
  );
}

interface TransferLine {
  sourceItemId: string;
  destinationItemId: string;
  quantity: string;
}

const EMPTY_LINE: TransferLine = { sourceItemId: "", destinationItemId: "", quantity: "" };

/** Loads the active items (with stock) for one warehouse, refetching when it changes. */
function useLocationItems(locationId: string): { items: LocationItem[]; loading: boolean } {
  const [items, setItems] = useState<LocationItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!locationId) {
      setItems([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api<{ items: LocationItem[] }>(
      `/api/inventory/location-items?locationId=${encodeURIComponent(locationId)}`,
    ).then(({ ok, data }) => {
      if (cancelled) return;
      setItems(ok ? data.items ?? [] : []);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  return { items, loading };
}

function TransferForm({
  locations,
  busy,
  run,
  onCreated,
}: {
  locations: Location[];
  busy: boolean;
  run: Runner;
  onCreated: () => void;
}) {
  const [sourceId, setSourceId] = useState("");
  const [destId, setDestId] = useState("");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<TransferLine[]>([{ ...EMPTY_LINE }]);
  const [formError, setFormError] = useState("");

  const { items: sourceItemsRaw, loading: loadingSource } = useLocationItems(sourceId);
  const { items: destItemsRaw, loading: loadingDest } = useLocationItems(destId);

  // The item selections belong to whichever branch was chosen when they were
  // picked; changing a branch invalidates that side's picks, so clear them (and
  // any stale error) rather than send IDs from the wrong warehouse to the API.
  const firstSource = useRef(true);
  useEffect(() => {
    if (firstSource.current) {
      firstSource.current = false;
      return;
    }
    setLines((prev) => prev.map((l) => ({ ...l, sourceItemId: "" })));
    setFormError("");
  }, [sourceId]);

  const firstDest = useRef(true);
  useEffect(() => {
    if (firstDest.current) {
      firstDest.current = false;
      return;
    }
    setLines((prev) => prev.map((l) => ({ ...l, destinationItemId: "" })));
    setFormError("");
  }, [destId]);

  const locationOptions = useMemo(
    () => [
      { value: "", label: "شعبه را انتخاب کنید…" },
      ...locations.map((l) => ({ value: l.id, label: l.name })),
    ],
    [locations],
  );

  const sourceItems = useMemo(() => sourceItemsRaw.filter((i) => i.stock > 0), [sourceItemsRaw]);
  const sourceStockById = useMemo(
    () => new Map(sourceItemsRaw.map((i) => [i.id, i.stock])),
    [sourceItemsRaw],
  );

  const sourceItemOptions = useMemo(
    () => [
      { value: "", label: "قلم انبار مبدأ…" },
      ...sourceItems.map((i) => ({
        value: i.id,
        label: `${i.name} (${formatQuantity(i.stock)} ${i.unit})`,
        searchString: [i.name, i.sku].filter(Boolean).join(" "),
      })),
    ],
    [sourceItems],
  );

  const destItemOptions = useMemo(
    () => [
      { value: "", label: "قلم انبار مقصد…" },
      ...destItemsRaw.map((i) => ({
        value: i.id,
        label: `${i.name} (${i.unit})`,
        searchString: [i.name, i.sku].filter(Boolean).join(" "),
      })),
    ],
    [destItemsRaw],
  );

  const sameLocation = Boolean(sourceId) && sourceId === destId;

  function updateLine(index: number, patch: Partial<TransferLine>) {
    setFormError("");
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }
  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  }
  function removeLine(index: number) {
    setLines((prev) => prev.filter((_, i) => i !== index));
  }

  /** Per-line problem, shown under the line so the user knows why submit is blocked. */
  function lineError(line: TransferLine): string | null {
    if (!line.sourceItemId && !line.destinationItemId && !line.quantity.trim()) return null;
    if (!line.sourceItemId) return "قلم مبدأ را انتخاب کنید.";
    if (!line.destinationItemId) return "قلم مقصد را انتخاب کنید.";
    const qty = Number(line.quantity);
    if (!line.quantity.trim() || !Number.isFinite(qty) || qty <= 0) return "مقدار باید بزرگ‌تر از صفر باشد.";
    const available = sourceStockById.get(line.sourceItemId);
    if (available !== undefined && qty > available) {
      return `مقدار از موجودی مبدأ (${formatQuantity(available)}) بیشتر است.`;
    }
    return null;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError("");

    if (!sourceId || !destId) {
      setFormError("انبار مبدأ و مقصد را انتخاب کنید.");
      return;
    }
    if (sourceId === destId) {
      setFormError("انبار مبدأ و مقصد نمی‌توانند یکی باشند.");
      return;
    }

    const filled = lines.filter((l) => l.sourceItemId || l.destinationItemId || l.quantity.trim());
    if (filled.length === 0) {
      setFormError("حداقل یک ردیف با قلم و مقدار لازم است.");
      return;
    }
    for (const line of filled) {
      const err = lineError(line);
      if (err) {
        setFormError(err);
        return;
      }
    }

    const ok = await run(() =>
      api("/api/inventory/transfers", {
        method: "POST",
        body: JSON.stringify({
          sourceLocationId: sourceId,
          destinationLocationId: destId,
          note: note.trim() || null,
          idempotencyKey: `transfer-${Date.now()}`,
          lines: filled.map((l) => ({
            sourceInventoryItemId: l.sourceItemId,
            destinationInventoryItemId: l.destinationItemId,
            quantity: l.quantity,
          })),
        }),
      }),
    );
    if (ok) {
      setNote("");
      setLines([{ ...EMPTY_LINE }]);
      onCreated();
    }
  }

  const canSubmit = Boolean(sourceId) && Boolean(destId) && !sameLocation && !busy;

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
            <SearchableSelect
              value={sourceId}
              onChange={setSourceId}
              options={locationOptions}
              ariaLabel="انبار مبدأ"
            />
          </Field>
          <Field label="انبار مقصد">
            <SearchableSelect
              value={destId}
              onChange={setDestId}
              options={locationOptions}
              ariaLabel="انبار مقصد"
            />
          </Field>
          <Field label="یادداشت">
            <input
              className={inputClass}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="اختیاری"
              maxLength={500}
            />
          </Field>
        </div>

        {sameLocation ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            انبار مبدأ و مقصد نمی‌توانند یکی باشند.
          </p>
        ) : null}

        <div className="space-y-2">
          {lines.map((line, i) => {
            const err = lineError(line);
            return (
              <div key={i} className="rounded-xl border border-border/80 p-3">
                <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_minmax(0,10rem)_auto]">
                  <Field label="قلم مبدأ">
                    <SearchableSelect
                      value={line.sourceItemId}
                      onChange={(v) => updateLine(i, { sourceItemId: v })}
                      options={sourceItemOptions}
                      disabled={!sourceId || loadingSource}
                      loading={loadingSource}
                      ariaLabel="قلم مبدأ"
                      emptyText={sourceId ? "قلمی با موجودی در این انبار نیست." : "ابتدا انبار مبدأ را انتخاب کنید."}
                    />
                  </Field>
                  <Field label="قلم مقصد">
                    <SearchableSelect
                      value={line.destinationItemId}
                      onChange={(v) => updateLine(i, { destinationItemId: v })}
                      options={destItemOptions}
                      disabled={!destId || loadingDest}
                      loading={loadingDest}
                      ariaLabel="قلم مقصد"
                      emptyText={destId ? "قلمی در این انبار نیست." : "ابتدا انبار مقصد را انتخاب کنید."}
                    />
                  </Field>
                  <Field label="مقدار">
                    <PersianNumberInput
                      className={inputClass}
                      dir="ltr"
                      inputMode="decimal"
                      allowNegative={false}
                      value={line.quantity}
                      onChange={(e) => updateLine(i, { quantity: e.target.value })}
                    />
                  </Field>
                  <div className="flex items-end">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive xl:w-auto"
                      onClick={() => removeLine(i)}
                      disabled={lines.length === 1}
                    >
                      حذف ردیف
                    </Button>
                  </div>
                </div>
                {err ? <p className="mt-2 text-xs text-destructive">{err}</p> : null}
              </div>
            );
          })}
        </div>

        {formError ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive"
          >
            {formError}
          </p>
        ) : null}

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={addLine} className="sm:w-auto">
            افزودن ردیف
          </Button>
          <Button
            type="submit"
            disabled={!canSubmit}
            size="lg"
            className="w-full px-5 font-semibold sm:ms-auto sm:w-52"
          >
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
