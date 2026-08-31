"use client";

import { MinusIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import {
  formatModifierDelta,
  linePriceBreakdown,
  type DisplayModifier,
} from "@/lib/modifier-display";
import { ModifierBadges } from "../modifier-badges";
import { useMoney } from "@/components/money/money-context";

/**
 * One sellable configuration in the till's cart.
 *
 * The key word is *configuration*: «قهوه با شکلات» and «قهوه بدون شکلات» are two
 * different lines, each with its own quantity selector sitting beside it. The
 * card therefore presents the item and *its* number as one unit, and the add-ons
 * as a visually separated sub-block of that same card — so a − / + press can
 * never be mistaken for adjusting something other than the line it is printed
 * on.
 */
export interface CartLineCardData {
  key: string;
  name: string;
  unitPrice: number;
  quantity: number;
  modifiers: DisplayModifier[];
  note: string;
}

/**
 * The cart line, identical on the desktop panel and the phone sheet. One
 * component (not two markups that used to drift apart) so the quantity
 * selector, the add-on block and the edit/delete actions read and behave the
 * same at every width.
 *
 * The layout deliberately answers "what does this number adjust?": the stepper
 * lives in the line's own header, on the edge the cashier's thumb reaches,
 * while the add-ons are indented beneath the item with their own «روی هر واحد»
 * caption — the number belongs to the line, the chips describe what each unit
 * carries.
 */
export function CartLineCard({
  line,
  onStep,
  onEdit,
  onRemove,
}: {
  line: CartLineCardData;
  onStep: (key: string, delta: 1 | -1) => void;
  onEdit: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const money = useMoney();
  const hasAddOns = line.modifiers.length > 0;
  const breakdown = linePriceBreakdown({
    unitPrice: line.unitPrice,
    modifierDeltas: line.modifiers.map((modifier) => modifier.priceDelta),
    quantity: line.quantity,
  });

  return (
    <li
      className={
        "rounded-xl border p-3 text-sm animate-in fade-in slide-in-from-top-1 duration-150 " +
        (hasAddOns
          ? "border-amber-200 bg-amber-50"
          : "border-stone-200/80 bg-card")
      }
    >
      {/* Header: the item and ITS number selector together. The stepper is on
          the inline edge in RTL (right side), inside this card, so it is
          unmistakably attached to this line. */}
      <div className="flex items-center gap-2.5">
        <div
          className="flex shrink-0 items-center gap-0.5 rounded-lg border border-stone-200/80 bg-stone-50 p-0.5"
          role="group"
          aria-label={
            hasAddOns
              ? "تعداد این ترکیب از " + line.name + " (با افزودنی‌ها)"
              : "تعداد " + line.name
          }
        >
          <button
            type="button"
            aria-label={
              hasAddOns
                ? "کاهش تعداد این ترکیب از " + line.name
                : "کاهش تعداد " + line.name
            }
            onClick={() => onStep(line.key, -1)}
            className="flex size-10 items-center justify-center rounded-md text-stone-600 transition-colors hover:bg-amber-100 hover:text-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-95 motion-reduce:transition-none"
          >
            <MinusIcon className="size-4" aria-hidden="true" />
          </button>
          <span
            className="min-w-7 text-center text-sm font-bold text-stone-950"
            aria-live="polite"
          >
            {toPersianDigits(line.quantity)}
          </span>
          <button
            type="button"
            aria-label={
              hasAddOns
                ? "افزایش تعداد این ترکیب از " +
                  line.name +
                  " (افزودنی‌ها روی واحد جدید هم اعمال می‌شود)"
                : "افزایش تعداد " + line.name
            }
            onClick={() => onStep(line.key, 1)}
            className="flex size-10 items-center justify-center rounded-md text-amber-700 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45 active:scale-95 motion-reduce:transition-none"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
          </button>
        </div>
        <p
          className="min-w-0 flex-1 truncate font-bold text-stone-950"
          title={line.name}
        >
          {line.name}
        </p>
        <p className="shrink-0 text-sm font-bold text-amber-700">
          {money.format(breakdown.total)}
        </p>
      </div>

      {/* The add-ons, separated from the item: an indented, tinted sub-block
          with its own caption and per-unit money, so the chips read as "what
          each unit carries" rather than as another cart row. */}
      {hasAddOns ? (
        <div className="me-1 mt-2 rounded-lg border border-amber-200/70 bg-amber-50 px-2.5 py-2">
          <ModifierBadges modifiers={line.modifiers} tone="amber" showCaption />
          <p className="mt-1.5 flex flex-wrap items-center gap-x-1 text-[11px] text-stone-500">
            <span>{money.format(line.unitPrice, { withUnit: false })}</span>
            <span aria-hidden="true">+</span>
            <span className="font-bold text-amber-700">
              {formatModifierDelta(breakdown.addOns, {
                withUnit: false,
                unit: money.unit,
              })}
            </span>
            <span aria-hidden="true">=</span>
            <span className="font-bold text-stone-950">
              {money.format(breakdown.unit)}
            </span>
            <span className="text-stone-500">برای هر واحد</span>
          </p>
        </div>
      ) : (
        <p className="me-1 mt-1.5 text-xs text-stone-500">
          {money.format(line.unitPrice)} برای هر واحد
        </p>
      )}

      {line.note ? (
        <p className="me-1 mt-2 text-xs text-stone-500">
          یادداشت: {line.note}
        </p>
      ) : null}

      {/* Line actions: changing the configuration (edit) and dropping it. Edit
          is how "one of these without the topping" is fixed after the fact
          without deleting and re-ringing the whole line. */}
      <div className="mt-2 flex items-center justify-start gap-1 border-t border-stone-200/80/70 pt-2">
        <button
          type="button"
          onClick={() => onEdit(line.key)}
          className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/45"
        >
          <PencilIcon className="size-3.5" aria-hidden="true" />
          تغییر افزودنی‌ها
        </button>
        <button
          type="button"
          onClick={() => onRemove(line.key)}
          className="flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-bold text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive/40"
        >
          <Trash2Icon className="size-3.5" aria-hidden="true" />
          حذف
        </button>
      </div>
    </li>
  );
}
