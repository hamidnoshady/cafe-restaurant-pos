"use client";

import { useMemo, useState } from "react";
import { CheckIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import {
  formatModifierDelta,
  isModifierGroupSatisfied,
  linePriceBreakdown,
  modifierGroupProgressLabel,
  modifierGroupRuleLabel,
} from "@/lib/modifier-display";
import { MODIFIER_TONE, type ModifierTone } from "./modifier-badges";
import { inputClass } from "./ui";

export interface ModifierGroupWithModifiers {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  modifiers: { id: string; name: string; price_delta: string | number }[];
}

/** Buckets already-chosen add-on ids back into their groups, honouring each group's max_select. */
function initialSelection(
  groups: ModifierGroupWithModifiers[],
  modifierIds: string[],
): Record<string, string[]> {
  const chosen = new Set(modifierIds);
  const selection: Record<string, string[]> = {};
  for (const group of groups) {
    const picked = group.modifiers
      .filter((modifier) => chosen.has(modifier.id))
      .map((modifier) => modifier.id)
      .slice(0, group.max_select);
    if (picked.length > 0) selection[group.id] = picked;
  }
  return selection;
}

/**
 * Modal for picking add-ons (respecting each group's min/max select) before an
 * item goes into a cart or an open order.
 *
 * Add-ons change what the customer pays, so the picker states the money at
 * every step: each option carries its own delta, each group states whether it
 * is required, and the footer shows base price → add-ons → unit price → line
 * total *before* the item is committed. `itemPrice` is what makes that footer
 * possible; without it the picker still works and simply shows the add-on
 * total on its own.
 */
export function ModifierPicker({
  itemName,
  itemPrice,
  quantity = 1,
  groups,
  tone = "brand",
  initialModifierIds,
  initialNote = "",
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  itemName: string;
  /** Menu price of one unit, integer Rial. Omitted when the caller has no price at hand. */
  itemPrice?: number;
  /** How many units this selection will add — makes the footer show the real line total. */
  quantity?: number;
  groups: ModifierGroupWithModifiers[];
  tone?: ModifierTone;
  /**
   * Add-ons already on the line, for re-picking rather than first picking (an
   * open order's line). Ids that no longer belong to one of `groups` are
   * dropped — the picker can only ever hand back a selection it displayed.
   */
  initialModifierIds?: string[];
  /** The line's existing note, edited alongside its add-ons. */
  initialNote?: string;
  /** Overrides the default «افزودن» wording when this is an edit, not an add. */
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (modifierIds: string[], note: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    initialSelection(groups, initialModifierIds ?? []),
  );
  const [note, setNote] = useState(initialNote);
  const palette = MODIFIER_TONE[tone];

  function toggle(group: ModifierGroupWithModifiers, modifierId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? [];
      if (group.max_select === 1) {
        return {
          ...prev,
          [group.id]: current.includes(modifierId) ? [] : [modifierId],
        };
      }
      if (current.includes(modifierId)) {
        return {
          ...prev,
          [group.id]: current.filter((id) => id !== modifierId),
        };
      }
      if (current.length >= group.max_select) return prev;
      return { ...prev, [group.id]: [...current, modifierId] };
    });
  }

  const chosen = useMemo(
    () =>
      groups.flatMap((group) =>
        (selected[group.id] ?? []).flatMap((id) => {
          const modifier = group.modifiers.find((m) => m.id === id);
          return modifier
            ? [
                {
                  name: modifier.name,
                  priceDelta: Number(modifier.price_delta),
                },
              ]
            : [];
        }),
      ),
    [groups, selected],
  );

  const breakdown = linePriceBreakdown({
    unitPrice: itemPrice ?? 0,
    modifierDeltas: chosen.map((modifier) => modifier.priceDelta),
    quantity,
  });

  const canConfirm = groups.every((group) =>
    isModifierGroupSatisfied(
      (selected[group.id] ?? []).length,
      group.min_select,
      group.max_select,
    ),
  );

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent className="flex max-h-[88vh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="text-lg">{itemName}</DialogTitle>
          {itemPrice !== undefined ? (
            <p className="mt-1 text-sm text-muted-foreground">
              قیمت پایه:{" "}
              <span className={`font-bold ${palette.accent}`}>
                {formatToman(itemPrice)}
              </span>
            </p>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {groups.map((group) => {
            const groupSelection = selected[group.id] ?? [];
            const satisfied = isModifierGroupSatisfied(
              groupSelection.length,
              group.min_select,
              group.max_select,
            );
            return (
              <fieldset
                key={group.id}
                className="rounded-xl border border-border p-3"
              >
                <legend className="flex flex-wrap items-center gap-2 px-1">
                  <span className="text-sm font-bold text-foreground">
                    {group.name}
                  </span>
                  <span
                    className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-bold ${
                      group.min_select > 0 && !satisfied
                        ? "bg-destructive/10 text-destructive"
                        : `${palette.surface} border ${palette.accent}`
                    }`}
                  >
                    {modifierGroupRuleLabel(group.min_select, group.max_select)}
                  </span>
                </legend>
                <p className="mb-2 mt-1 px-1 text-[11px] text-muted-foreground">
                  {modifierGroupProgressLabel(
                    groupSelection.length,
                    group.max_select,
                  )}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {group.modifiers.map((modifier) => {
                    const isOn = groupSelection.includes(modifier.id);
                    const atCeiling =
                      !isOn && groupSelection.length >= group.max_select;
                    const delta = Number(modifier.price_delta);
                    return (
                      <button
                        key={modifier.id}
                        type="button"
                        aria-pressed={isOn}
                        disabled={atCeiling}
                        onClick={() => toggle(group, modifier.id)}
                        className={`flex min-h-14 items-center justify-between gap-2 rounded-xl border px-3 py-2 text-start transition duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:opacity-45 motion-reduce:transition-none ${
                          isOn ? palette.optionSelected : palette.option
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`flex size-5 shrink-0 items-center justify-center rounded-md border ${
                              isOn
                                ? "border-current bg-current/10"
                                : "border-input"
                            }`}
                            aria-hidden="true"
                          >
                            {isOn ? <CheckIcon className="size-3.5" /> : null}
                          </span>
                          <span className="truncate text-sm font-bold">
                            {modifier.name}
                          </span>
                        </span>
                        <span
                          className={`shrink-0 text-xs font-bold ${
                            isOn ? "" : palette.chipPrice
                          }`}
                        >
                          {formatModifierDelta(delta)}
                        </span>
                      </button>
                    );
                  })}
                  {group.modifiers.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      افزودنی فعالی در این گروه ثبت نشده است.
                    </p>
                  ) : null}
                </div>
              </fieldset>
            );
          })}

          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-foreground">
              یادداشت{" "}
              <span className="font-normal text-muted-foreground">
                (اختیاری)
              </span>
            </span>
            <input
              className={inputClass}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="مثلاً: بدون شکر"
            />
          </label>
        </div>

        <div className="border-t border-border px-5 py-4">
          {itemPrice !== undefined ? (
            <dl
              className={`mb-3 space-y-1 rounded-xl border p-3 text-sm ${palette.surface}`}
            >
              <div className="flex justify-between text-muted-foreground">
                <dt>قیمت پایه</dt>
                <dd>{formatToman(breakdown.base)}</dd>
              </div>
              <div className="flex justify-between text-muted-foreground">
                <dt>
                  افزودنی‌ها{" "}
                  {chosen.length > 0
                    ? `(${toPersianDigits(chosen.length)} مورد)`
                    : ""}
                </dt>
                <dd className={chosen.length > 0 ? palette.accent : ""}>
                  {formatModifierDelta(breakdown.addOns)}
                </dd>
              </div>
              <div className="flex justify-between border-t border-current/10 pt-1 text-base font-bold text-foreground">
                <dt>قیمت هر واحد</dt>
                <dd>{formatToman(breakdown.unit)}</dd>
              </div>
              {quantity > 1 ? (
                <div className="flex justify-between text-muted-foreground">
                  <dt>{toPersianDigits(quantity)} واحد</dt>
                  <dd>{formatToman(breakdown.total)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="min-h-12 shrink-0 rounded-xl border border-input px-4 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
            >
              انصراف
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={() =>
                onConfirm(
                  groups.flatMap((group) => selected[group.id] ?? []),
                  note.trim(),
                )
              }
              className={`min-h-12 flex-1 rounded-xl px-4 text-sm font-bold transition duration-200 active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 disabled:opacity-50 motion-reduce:transition-none ${palette.cta}`}
            >
              {canConfirm
                ? itemPrice !== undefined
                  ? `${confirmLabel ?? "افزودن"} — ${formatToman(breakdown.total)}`
                  : (confirmLabel ?? "افزودن")
                : "ابتدا گروه‌های الزامی را انتخاب کنید"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
