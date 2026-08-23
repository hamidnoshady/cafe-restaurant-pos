"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ScanBarcodeIcon } from "lucide-react";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { api, Field, inputClass } from "../ui";

/**
 * Scan-driven entry for a physical stock count.
 *
 * The counterpart of the retail invoice screen's `BarcodeScanField`, aimed at
 * the one job that screen never had to do: several thousand reads in a row, by
 * someone holding a scanner in a store room. Two consequences shape it, and
 * both are deliberate departures from the sell-screen version:
 *
 *  - **The input is never disabled while a lookup is in flight.** A handheld
 *    scanner is a keyboard: it types the code and presses Enter whenever the
 *    trigger is pulled, with no idea the page is busy. Disabling the field
 *    between scans (as the sell screen can afford to) silently drops the next
 *    read. Lookups are independent fetches and every tally update is a
 *    functional `setState`, so overlapping scans are safe.
 *  - **Focus returns to the field after every scan**, including after an
 *    error, so a whole aisle is counted without touching the screen.
 *
 * Each scan adds `qtyPerScan` (default ۱) to that item's counted quantity —
 * settable so a case of twelve can be one read rather than twelve.
 */
export interface ScanMatch {
  inventoryItemId: string;
  itemName: string;
  unit: string;
  code: string;
}

interface ScanFeedback {
  kind: "ok" | "error";
  message: string;
}

export function CountScanField({
  onScan,
  isCountable,
  runningTotal,
}: {
  /** Adds `qty` to this item's counted quantity; the parent owns the tally. */
  onScan: (match: ScanMatch, qty: number) => void;
  /** Whether this ingredient can be counted here (active, at this branch). */
  isCountable: (inventoryItemId: string) => boolean;
  /** The tally after the parent applied the last scan, for read-back. */
  runningTotal: (inventoryItemId: string) => string | undefined;
}) {
  const [code, setCode] = useState("");
  const [qtyPerScan, setQtyPerScan] = useState("1");
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastScanned = useRef<ScanMatch | null>(null);

  // Read-back has to happen after the parent's state settles, so the operator
  // sees the new tally rather than the one before their scan.
  useEffect(() => {
    const match = lastScanned.current;
    if (!match) return;
    const total = runningTotal(match.inventoryItemId);
    if (total === undefined) return;
    setFeedback({
      kind: "ok",
      message: `${match.itemName} — شمارش‌شده: ${formatQuantity(total)} ${match.unit}`,
    });
  }, [scanCount, runningTotal]);

  const resolve = useCallback(
    async (rawCode: string) => {
      const needle = rawCode.trim();
      if (!needle) return;
      setCode("");
      inputRef.current?.focus();

      const step = Number(qtyPerScan);
      if (!Number.isFinite(step) || step <= 0) {
        setFeedback({ kind: "error", message: "مقدار هر اسکن باید عددی مثبت باشد." });
        return;
      }

      const { ok, data } = await api<{ matches?: ScanMatch[]; message?: string }>(
        `/api/inventory/barcodes/lookup?code=${encodeURIComponent(needle)}`,
      );
      if (!ok) {
        setFeedback({ kind: "error", message: data.message ?? "بارکد خوانده نشد." });
        return;
      }
      const matches = data.matches ?? [];
      if (matches.length === 0) {
        setFeedback({
          kind: "error",
          message: `بارکد ${toPersianDigits(needle)} به هیچ قلمی متصل نیست؛ ابتدا برچسب آن را ثبت کنید.`,
        });
        return;
      }
      // UNIQUE (location_id, code) makes more than one match impossible, but
      // surface it rather than silently taking the first if it ever happens.
      if (matches.length > 1) {
        setFeedback({ kind: "error", message: "این بارکد به بیش از یک قلم اشاره دارد." });
        return;
      }
      const match = matches[0];
      if (!isCountable(match.inventoryItemId)) {
        setFeedback({
          kind: "error",
          message: `«${match.itemName}» در این شعبه فعال نیست و شمارش نمی‌شود.`,
        });
        return;
      }

      onScan(match, step);
      lastScanned.current = match;
      setScanCount((n) => n + 1);
    },
    [isCountable, onScan, qtyPerScan],
  );

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <ScanBarcodeIcon className="size-4" aria-hidden="true" />
        <span>شمارش با بارکدخوان</span>
      </div>
      <p className="mb-3 text-xs leading-5 text-muted-foreground">
        بارکد هر قلم را اسکن کنید؛ مقدار شمارش‌شدهٔ همان قلم به‌طور خودکار
        افزوده می‌شود. نیازی به لمس صفحه بین اسکن‌ها نیست.
      </p>
      <div className="grid gap-3 sm:grid-cols-[1fr_8rem]">
        <Field label="بارکد">
          <input
            ref={inputRef}
            className={inputClass}
            dir="ltr"
            value={code}
            autoFocus
            placeholder="اسکن بارکد…"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                // A scanner's Enter must not submit the surrounding count form.
                e.preventDefault();
                void resolve(code);
              }
            }}
          />
        </Field>
        <Field label="مقدار هر اسکن">
          <input
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={qtyPerScan}
            onChange={(e) => setQtyPerScan(e.target.value)}
          />
        </Field>
      </div>
      {feedback ? (
        <p
          className={`mt-2 text-xs leading-5 ${
            feedback.kind === "ok" ? "text-emerald-700" : "text-rose-700"
          }`}
          role="status"
          aria-live="polite"
        >
          {feedback.message}
        </p>
      ) : null}
      {scanCount > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {toPersianDigits(scanCount)} اسکن در این شمارش
        </p>
      ) : null}
    </div>
  );
}
