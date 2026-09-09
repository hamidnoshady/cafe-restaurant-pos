"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { CameraScanTrigger } from "@/components/scanner/camera-barcode-scanner";
import { toPersianDigits } from "@/lib/digits";
import { printLabel } from "@/lib/print-agent-client";
import type { LabelData } from "@/lib/label-template";
import { firstPrinter, useBusinessInfo, usePrinters } from "../use-printers";
import { SectionCard } from "../page-chrome";
import { api, Field, inputClass } from "../ui";
import type { InventoryItem, Runner } from "./inventory-manager";

/**
 * Barcodes and shelf labels for raw ingredients — the step that has to happen
 * before a store room can be counted with a scanner at all.
 *
 * The retail trades got this in Phase 27 Wave 4 (`/api/barcodes`, the label
 * panel on the merchandising screen). F&B's `inventory_items` never had it, so
 * the only "code" an ingredient carried was `sku`, a search hint no scanner
 * emits. The label itself reuses the existing ESC/POS raster path
 * (`printLabel` → `renderLabelHtml`) unchanged; an ingredient's label carries
 * the unit rather than a shelf price, because raw stock is not priced to sell.
 */
interface BarcodeRow {
  id: string;
  inventoryItemId: string;
  code: string;
  symbology: string;
  note: string | null;
}

interface PendingItem {
  id: string;
  name: string;
  unit: string;
}



export function BarcodesSection({
  items,
  busy,
  run,
}: {
  items: InventoryItem[];
  busy: boolean;
  run: Runner;
}) {
  const [pending, setPending] = useState<PendingItem[] | null>(null);
  const [itemId, setItemId] = useState("");
  const [manualCode, setManualCode] = useState("");
  const [barcodes, setBarcodes] = useState<BarcodeRow[]>([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const printers = usePrinters();
  const businessInfo = useBusinessInfo();

  const selected = items.find((i) => i.id === itemId);

  const loadPending = useCallback(() => {
    api<{ pending: PendingItem[] }>("/api/inventory/barcodes").then(({ ok, data }) => {
      if (ok) setPending(data.pending);
    });
  }, []);
  useEffect(loadPending, [loadPending]);

  const loadBarcodes = useCallback(() => {
    if (!itemId) {
      setBarcodes([]);
      return;
    }
    api<{ barcodes: BarcodeRow[] }>(
      `/api/inventory/barcodes?inventoryItemId=${encodeURIComponent(itemId)}`,
    ).then(({ ok, data }) => {
      if (ok) setBarcodes(data.barcodes);
    });
  }, [itemId]);
  useEffect(loadBarcodes, [loadBarcodes]);

  async function assign(generate: boolean) {
    if (!itemId) return;
    setError("");
    setNotice("");
    const ok = await run(() =>
      api("/api/inventory/barcodes", {
        method: "POST",
        body: JSON.stringify(
          generate ? { inventoryItemId: itemId } : { inventoryItemId: itemId, code: manualCode },
        ),
      }),
    );
    if (ok) {
      setManualCode("");
      loadBarcodes();
      loadPending();
    }
  }

  async function mintAll() {
    setError("");
    setNotice("");
    const { ok, data } = await api<{ minted?: number; message?: string }>(
      "/api/inventory/barcodes/bulk",
      { method: "POST" },
    );
    if (!ok) {
      setError(data.message ?? "تولید بارکد ناموفق بود.");
      return;
    }
    setNotice(`${toPersianDigits(data.minted ?? 0)} بارکد داخلی تولید شد.`);
    loadPending();
    loadBarcodes();
  }

  function print(code: string, item: { name: string; unit: string }) {
    setError("");
    const printer = firstPrinter(printers, "receipt");
    if (!printer) {
      setError("چاپگر رسید در این شعبه ثبت نشده است.");
      return;
    }
    const label: LabelData = {
      businessName: businessInfo.name || "انبار",
      itemName: item.name,
      code,
      fields: [{ label: "واحد", value: item.unit }],
    };
    printLabel(printer.connection, label).then((res) => {
      if (res.ok) setNotice("لیبل چاپ شد.");
      else {
        setError(
          res.error === "agent_unreachable" ? "چاپگر محلی در دسترس نیست." : "چاپ لیبل ناموفق بود.",
        );
      }
    });
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">آماده‌سازی</p>
            <h2 className="mt-1 font-semibold text-foreground">آماده‌سازی انبار برای شمارش</h2>
          </div>
        }
        description="شمارش با بارکدخوان تنها برای اقلامی کار می‌کند که بارکد داشته باشند. اقلامی که هنوز بارکد ندارند در فهرست زیر می‌آیند؛ با یک دکمه برای همهٔ آن‌ها بارکد داخلی تولید کنید و سپس لیبل‌ها را چاپ و روی قفسه‌ها نصب کنید."
      >
        {pending === null ? (
          <LoadingSkeleton rows={3} />
        ) : pending.length === 0 ? (
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            همهٔ اقلام فعال بارکد دارند؛ انبار آمادهٔ شمارش است.
          </p>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <span className="text-sm">
                {toPersianDigits(pending.length)} قلم بدون بارکد
              </span>
              <Button
                type="button"
                disabled={busy}
                variant="outline" size="lg"
                onClick={() => void mintAll()}
              >
                تولید بارکد برای همه
              </Button>
            </div>
            <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {pending.map((p) => (
                <li key={p.id} className="px-3 py-2 text-sm">
                  {p.name}{" "}
                  <span className="text-xs text-muted-foreground">({p.unit})</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {notice ? <p className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
        {error ? <p className="mt-3 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      </SectionCard>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت بارکد</p>
            <h2 className="mt-1 font-semibold text-foreground">بارکد یک قلم</h2>
          </div>
        }
        description="اگر بسته‌بندی تأمین‌کننده بارکد چاپی دارد، همان را ثبت کنید تا نیازی به لیبل تازه نباشد."
      >
        <Field label="قلم انبار">
          <select
            className={inputClass}
            value={itemId}
            onChange={(e) => setItemId(e.target.value)}
          >
            <option value="">انتخاب قلم</option>
            {items
              .filter((i) => i.is_active)
              .map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
          </select>
        </Field>
        <div className="mt-3 grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[1fr_auto_auto]">
          <input
            className={inputClass}
            dir="ltr"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            placeholder="بارکد تأمین‌کننده (EAN-13 یا UPC)"
          />
          <CameraScanTrigger
            label="دوربین"
            disabled={busy || !selected}
            className="gap-1.5 min-h-[44px] border-border px-4 text-foreground/80"
            title="خواندن بارکد تأمین‌کننده"
            description="بارکد روی بسته‌بندی را با دوربین بخوانید تا روی این قلم ثبت شود."
            onScan={(scanned) => setManualCode(scanned)}
          />
          <Button
            type="button"
            disabled={busy || !selected || !manualCode.trim()}
            variant="outline" size="lg"
            onClick={() => void assign(false)}
          >
            ثبت
          </Button>
        </div>
        <Button
          type="button"
          disabled={busy || !selected}
          variant="outline" size="lg" className="mt-2 w-full"
          onClick={() => void assign(true)}
        >
          تولید بارکد داخلی
        </Button>

        {selected && barcodes.length > 0 ? (
          <ul className="mt-3 divide-y divide-border rounded-lg border border-border">
            {barcodes.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                <span dir="ltr" className="font-mono">
                  {b.code}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => print(b.code, { name: selected.name, unit: selected.unit })}
                >
                  چاپ لیبل
                </Button>
              </li>
            ))}
          </ul>
        ) : selected ? (
          <p className="mt-3 text-xs text-muted-foreground">
            هنوز بارکدی برای این قلم ثبت نشده است.
          </p>
        ) : null}
      </SectionCard>
    </div>
  );
}
