"use client";

import { useEffect, useMemo, useState } from "react";
import { SearchIcon, UsersIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { listSelectableTables, type PosTable } from "@/lib/pos-selection";
import { inputClass } from "../ui";

/**
 * The one place a table is chosen, on every device.
 *
 * It is reached two ways, and `intent` is which: `"select"` when the cashier
 * opens it from the cart to seat the order up front, and `"order"`/`"payment"`
 * when they pressed one of the two close-the-sale buttons with no table picked
 * and are answering the question here instead of being sent back with an error.
 * Confirming hands the chosen table (and the guest count, which is only ever
 * asked alongside it) back to the POS, which carries on into whatever it was
 * headed for.
 *
 * The cart panel and the mobile sheet used to draw their own flat grids of every
 * table instead — no search, no capacity, no occupied state, and two more places
 * for the three to drift apart.
 *
 * An already-seated table is offered, not greyed out: friends at one table who
 * want separate bills are one party and several invoices, so the second order is
 * the point rather than a mistake to block. Only a table the server itself would
 * refuse — being cleaned, out of service — is unselectable here.
 */
export function TablePickerDialog({
  open,
  tables,
  selectedTableId,
  guestCount,
  intent,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  tables: PosTable[];
  selectedTableId: string;
  guestCount: string;
  intent: "order" | "payment" | "select";
  onCancel: () => void;
  onConfirm: (tableId: string, guestCount: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [draftTableId, setDraftTableId] = useState(selectedTableId);
  const [draftGuestCount, setDraftGuestCount] = useState(guestCount);

  // Each time the prompt comes up it starts from what the POS holds right now,
  // so an abandoned attempt never leaves a stale table pre-selected.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setDraftTableId(selectedTableId);
    setDraftGuestCount(guestCount);
  }, [open, selectedTableId, guestCount]);

  const choices = useMemo(
    () => listSelectableTables({ tables, query }),
    [tables, query],
  );
  const chosen = choices.find((table) => table.id === draftTableId);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>انتخاب میز</DialogTitle>
          <DialogDescription>
            {intent === "payment"
              ? "برای سفارش حضوری پیش از دریافت وجه، میز را انتخاب کنید."
              : intent === "order"
                ? "برای ثبت سفارش حضوری، میز را انتخاب کنید."
                : "میز این سفارش را انتخاب کنید. میز اشغال را هم می‌توانید انتخاب کنید؛ سفارش جدید صورت‌حساب جدا دارد."}
          </DialogDescription>
        </DialogHeader>

        {tables.length > 8 ? (
          <label className="relative block" htmlFor="pos-table-search">
            <span className="sr-only">جستجوی میز</span>
            <SearchIcon
              className="pointer-events-none absolute end-3 top-1/2 size-4 -translate-y-1/2 text-[#B9B6AE]"
              aria-hidden="true"
            />
            <input
              id="pos-table-search"
              className={inputClass + " min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="نام میز"
            />
          </label>
        ) : null}

        {tables.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#EAE8E2] bg-[#FCFCFA] p-4 text-center text-sm text-[#77756F]">
            هنوز میزی ثبت نشده است. از بخش میزها میز اضافه کنید یا نوع سفارش را
            به بیرون‌بر تغییر دهید.
          </p>
        ) : choices.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[#EAE8E2] bg-[#FCFCFA] p-4 text-center text-sm text-[#77756F]">
            میزی با این نام پیدا نشد.
          </p>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {choices.map((table) => (
                <li key={table.id}>
                  <button
                    type="button"
                    disabled={table.unavailable}
                    aria-pressed={draftTableId === table.id}
                    onClick={() => setDraftTableId(table.id)}
                    className={
                      "flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-xl border px-2 text-sm font-bold transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:cursor-not-allowed motion-reduce:transition-none " +
                      (draftTableId === table.id
                        ? "border-[#E9A11B] bg-[#FFF1D8] text-[#9B6700]"
                        : table.unavailable
                          ? "border-[#EAE8E2] bg-[#F5F4F1] text-[#B9B6AE]"
                          : "border-[#EAE8E2] text-[#5E5B55] hover:border-[#E9A11B]/60 hover:bg-[#FCFCFA]")
                    }
                  >
                    <span className="truncate">{table.name}</span>
                    <span className="flex items-center gap-1 text-xs font-normal">
                      {table.unavailable ? (
                        "در دسترس نیست"
                      ) : table.occupied ? (
                        "صورت‌حساب جدا"
                      ) : (
                        <>
                          <UsersIcon className="size-3" aria-hidden="true" />
                          {toPersianDigits(table.capacity)} نفر
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {chosen?.occupied ? (
              <p className="text-xs text-[#77756F]">
                این میز مهمان دارد. این سفارش، صورت‌حساب جداگانهٔ خودش را
                می‌گیرد و مستقل تسویه و چاپ می‌شود.
              </p>
            ) : null}
            <label
              className="block text-xs font-semibold text-[#5E5B55]"
              htmlFor="pos-table-guest-count"
            >
              تعداد مهمان{" "}
              <span className="font-normal text-[#8B8A85]">(اختیاری)</span>
              <input
                id="pos-table-guest-count"
                className={
                  inputClass + " mt-1 min-h-11 border-[#EAE8E2] bg-[#FCFCFA]"
                }
                dir="ltr"
                inputMode="numeric"
                value={draftGuestCount}
                onChange={(event) => setDraftGuestCount(event.target.value)}
                placeholder="اختیاری"
              />
            </label>
          </>
        )}

        <DialogFooter>
          <button
            type="button"
            onClick={onCancel}
            className="min-h-11 rounded-lg border border-input px-4 text-sm font-medium"
          >
            انصراف
          </button>
          <button
            type="button"
            disabled={!draftTableId || chosen?.unavailable === true}
            onClick={() => onConfirm(draftTableId, draftGuestCount)}
            className="min-h-12 rounded-xl bg-[#E9A11B] px-4 text-sm font-bold text-[#252522] transition duration-200 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E9A11B]/45 disabled:opacity-55 motion-reduce:transition-none"
          >
            {intent === "payment"
              ? "ادامه و دریافت وجه"
              : intent === "order"
                ? "ادامه و ثبت سفارش"
                : "ثبت میز"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
