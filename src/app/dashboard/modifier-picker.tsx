"use client";

/**
 * The add-on picker — one modal, three surfaces (cashier POS, waiter panel,
 * open-order editor), redesigned around action buttons instead of checkbox
 * rows:
 *
 *  * every option is a compact action button — press-and-hold (۲ ثانیه, with
 *    a visible fill) adds one unit and each further ۲ ثانیه adds another, so
 *    «شات اضافه ×۳» is one button held for ۶ ثانیه, not three rows; a short
 *    tap deliberately does nothing, and two quick taps take one unit off,
 *  * the item's own quantity stays a separate [-] n [+] stepper in the
 *    footer — the two counts never share a control,
 *  * a group's min/max counts the TOTAL chosen quantity (an extra shot ×۳
 *    against max_select ۳ uses the whole budget),
 *  * the note is a compact «+ افزودن یادداشت» action opening a small sheet
 *    that suggests the notes this item has actually collected,
 *  * header and footer stay put; only the groups scroll, and the page behind
 *    the modal does not scroll at all.
 *
 * Pricing states the money at every step, exactly as before: each option
 * carries its delta, and the footer shows base → add-ons → unit → line total
 * before the item is committed.
 */

import { useEffect, useMemo, useState } from "react";
import { MinusIcon, NotebookPenIcon, PlusIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  formatModifierDelta,
  isModifierGroupSatisfied,
  linePriceBreakdown,
  modifierGroupProgressLabel,
  modifierGroupRuleLabel,
  modifierDeltasOf,
} from "@/lib/modifier-display";
import { MODIFIER_TONE, type ModifierTone } from "./modifier-badges";
import { HoldRepeatButton } from "./hold-repeat-button";
import { api } from "./ui";
import { FOCUS } from "./orders/ops-styles";
import { MAX_ORDER_LINE_QUANTITY } from "@/lib/order-quantity";
import type { RestaurantGroupView } from "@/lib/restaurant-menu";

/**
 * A group as one menu item offers it — the canonical shared view
 * (restaurant-menu.ts), so the cashier, the waiter and the open-order editor
 * pick add-ons against the exact same resolved bounds.
 */
export type ModifierGroupWithModifiers = RestaurantGroupView;

/**
 * The add-on gesture, in one sentence, reused by the visible hint and by every
 * option's accessible name so the instruction a screen reader hears and the
 * one a cashier reads cannot drift apart.
 */
export const MODIFIER_HOLD_HINT =
  "برای افزودن، دکمه را ۲ ثانیه نگه دارید؛ نگه‌داشتن بیشتر، هر ۲ ثانیه یکی اضافه می‌کند. دو ضربهٔ سریع یکی کم می‌کند.";

/** What the picker hands back: add-on ids with their chosen quantities. */
export interface ModifierPickResult {
  id: string;
  quantity: number;
}

/**
 * Client-side cache of one menu item's suggested notes — the phrases the
 * kitchen has already seen on this item (see /api/orders/item-notes). Kept at
 * module scope because suggestions change with the day's orders, not with
 * each dialog; a fresh business session refetches naturally on reload.
 */
const noteSuggestionsCache = new Map<string, string[]>();

function useNoteSuggestions(menuItemId: string | undefined) {
  const [notes, setNotes] = useState<string[]>(() =>
    menuItemId ? (noteSuggestionsCache.get(menuItemId) ?? []) : [],
  );
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!menuItemId) return;
    const cached = noteSuggestionsCache.get(menuItemId);
    if (cached) {
      setNotes(cached);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void api<{ notes?: string[] }>("/api/orders/item-notes?itemId=" + encodeURIComponent(menuItemId)).then(
      ({ ok, data }) => {
        if (cancelled || !ok) return;
        noteSuggestionsCache.set(menuItemId, data.notes ?? []);
        setNotes(data.notes ?? []);
        setLoading(false);
      },
    ).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [menuItemId]);
  return { notes, loading };
}

/** Buckets already-chosen add-ons (with quantities) back into their groups. */
function initialSelection(
  groups: ModifierGroupWithModifiers[],
  initialModifiers: { id: string; quantity?: number }[] | undefined,
): Record<string, Record<string, number>> {
  const chosen = new Map(initialModifiers?.map((pick) => [pick.id, Math.max(1, Math.round(pick.quantity ?? 1))]) ?? []);
  const selection: Record<string, Record<string, number>> = {};
  for (const group of groups) {
    const picked: Record<string, number> = {};
    let units = 0;
    for (const modifier of group.modifiers) {
      const quantity = chosen.get(modifier.id);
      if (!quantity) continue;
      if (units + quantity > group.maxSelect) break; // respect the group's ceiling while restoring
      picked[modifier.id] = quantity;
      units += quantity;
    }
    if (Object.keys(picked).length > 0) selection[group.id] = picked;
  }
  return selection;
}

function groupTotal(selection: Record<string, number>): number {
  return Object.values(selection).reduce((sum, quantity) => sum + quantity, 0);
}

export function ModifierPicker({
  itemName,
  itemPrice,
  menuItemId,
  quantity = 1,
  selectQuantity = false,
  groups,
  tone = "brand",
  initialModifiers,
  initialNote = "",
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  itemName: string;
  /** Menu price of one unit, integer Rial. Omitted when the caller has no price at hand. */
  itemPrice?: number;
  /** For the note sheet's suggestions — the item whose past notes to offer. */
  menuItemId?: string;
  /** How many units this selection will add — makes the footer show the real line total. */
  quantity?: number;
  /**
   * Lets the picker set the count as well as the add-ons, and hands it back as
   * the third argument to `onConfirm`. On for the till, where "three of these,
   * no sugar" is one decision; off for callers re-picking the add-ons of a
   * line whose quantity is already settled elsewhere.
   */
  selectQuantity?: boolean;
  groups: ModifierGroupWithModifiers[];
  tone?: ModifierTone;
  /**
   * Add-ons already on the line, for re-picking rather than first picking (an
   * open order's line). Picks that no longer belong to one of `groups` are
   * dropped — the picker can only ever hand back a selection it displayed.
   */
  initialModifiers?: { id: string; quantity?: number }[];
  /** The line's existing note, edited alongside its add-ons. */
  initialNote?: string;
  /** Overrides the default «افزودن» wording when this is an edit, not an add. */
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (picks: ModifierPickResult[], note: string, quantity: number) => void;
}) {
  const money = useMoney();
  const [selected, setSelected] = useState<Record<string, Record<string, number>>>(() =>
    initialSelection(groups, initialModifiers),
  );
  const [note, setNote] = useState(initialNote);
  const [noteOpen, setNoteOpen] = useState(false);
  const { notes: suggestions, loading: suggestionsLoading } = useNoteSuggestions(menuItemId);
  // Only meaningful when `selectQuantity` is on; otherwise the prop is the
  // count and this never moves off it.
  const [count, setCount] = useState(() => Math.max(1, Math.round(quantity)));
  const effectiveQuantity = selectQuantity ? count : quantity;
  const palette = MODIFIER_TONE[tone];

  function setQuantityOf(groupId: string, modifierId: string, next: number) {
    setSelected((prev) => {
      const group = { ...prev[groupId] };
      if (next <= 0) delete group[modifierId];
      else group[modifierId] = next;
      const nextSelection = { ...prev, [groupId]: group };
      if (Object.keys(group).length === 0) delete nextSelection[groupId];
      return nextSelection;
    });
  }

  /**
   * Each ۲-second step of a hold: one more of the same add-on.
   *
   * Written as a state updater rather than off the render's `selected`, so a
   * hold that fires several increments between two renders (a long frame, a
   * fake-timer test advancing 6s at once) still counts every one of them and
   * still honours the group's ceiling on each.
   */
  function repeatAdd(group: ModifierGroupWithModifiers, modifierId: string) {
    setSelected((prev) => {
      const groupSelection = prev[group.id] ?? {};
      const current = groupSelection[modifierId] ?? 0;
      // A single-choice group (اندازه) holds exactly one unit of one option:
      // holding it selects it and then has nothing more to add.
      if (group.maxSelect <= 1) {
        if (current > 0) return prev;
        return { ...prev, [group.id]: { [modifierId]: 1 } };
      }
      if (groupTotal(groupSelection) >= group.maxSelect) return prev;
      return { ...prev, [group.id]: { ...groupSelection, [modifierId]: current + 1 } };
    });
  }

  /** Two quick taps on a chosen add-on: one unit fewer; zero unselects it. */
  function decrement(group: ModifierGroupWithModifiers, modifierId: string) {
    const current = (selected[group.id] ?? {})[modifierId] ?? 0;
    if (current <= 0) return;
    setQuantityOf(group.id, modifierId, current - 1);
  }

  /**
   * A button with nothing left to do: the group is full *and* this option
   * holds no unit, so neither the hold (add) nor the double tap (decrease)
   * could change anything. An option that still has units stays enabled even
   * at the ceiling — that is exactly when a cashier needs to take one off.
   */
  function optionBlocked(group: ModifierGroupWithModifiers, modifierId: string): boolean {
    const current = (selected[group.id] ?? {})[modifierId] ?? 0;
    if (current > 0) return false; // holds units → can always be decreased
    // Single-choice (اندازه): holding another option *replaces* the current
    // one, so a full group never blocks its siblings.
    if (group.maxSelect <= 1) return false;
    return groupTotal(selected[group.id] ?? {}) >= group.maxSelect;
  }

  const chosen = useMemo(
    () =>
      groups.flatMap((group) =>
        group.modifiers.flatMap((modifier) => {
          const quantity = (selected[group.id] ?? {})[modifier.id] ?? 0;
          return quantity > 0
            ? [{ id: modifier.id, name: modifier.name, priceDelta: modifier.priceDelta, quantity }]
            : [];
        }),
      ),
    [groups, selected],
  );

  const breakdown = linePriceBreakdown({
    unitPrice: itemPrice ?? 0,
    // The per-unit delta list repeats each add-on by its quantity — «شات ×۳»
    // prices as three shots on every unit of the line.
    modifierDeltas: modifierDeltasOf(chosen),
    quantity: effectiveQuantity,
  });

  const chosenUnits = chosen.reduce((sum, modifier) => sum + modifier.quantity, 0);

  const canConfirm = groups.every((group) =>
    isModifierGroupSatisfied(groupTotal(selected[group.id] ?? {}), group.minSelect, group.maxSelect),
  );

  function confirm() {
    onConfirm(
      chosen.map(({ id, quantity: modifierQuantity }) => ({ id, quantity: modifierQuantity })),
      note.trim(),
      effectiveQuantity,
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent
        className="flex max-h-[88dvh] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        showCloseButton={false}
      >
        <DialogHeader className="shrink-0 border-b border-border px-4 py-3">
          <DialogTitle className="text-base">{itemName}</DialogTitle>
          {itemPrice !== undefined ? (
            <p className="text-xs text-muted-foreground">
              قیمت پایه:{" "}
              <span className={`font-bold ${palette.accent}`}>{money.format(itemPrice)}</span>
            </p>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3">
          {groups.map((group) => {
            const groupSelection = selected[group.id] ?? {};
            const total = groupTotal(groupSelection);
            const satisfied = isModifierGroupSatisfied(total, group.minSelect, group.maxSelect);
            return (
              <fieldset key={group.id} className="rounded-xl border border-border p-2.5">
                <legend className="flex flex-wrap items-center gap-1.5 px-1">
                  <span className="text-sm font-bold text-foreground">{group.name}</span>
                  <span
                    className={`inline-flex items-center rounded-lg px-1.5 py-0.5 text-[11px] font-bold ${
                      group.minSelect > 0 && !satisfied
                        ? "bg-destructive/10 text-destructive"
                        : `${palette.surface} border ${palette.accent}`
                    }`}
                  >
                    {modifierGroupRuleLabel(group.minSelect, group.maxSelect)}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {modifierGroupProgressLabel(total, group.maxSelect)}
                  </span>
                </legend>
                {/*
                  Discoverability: the gesture is not guessable, so it is
                  written once per group, right above the buttons it applies
                  to — quiet enough not to compete with the options, present
                  enough that nobody has to be told twice.
                */}
                {group.modifiers.length > 0 ? (
                  <p className="mt-1.5 px-1 text-[11px] leading-4 text-muted-foreground">
                    {MODIFIER_HOLD_HINT}
                  </p>
                ) : null}
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  {group.modifiers.map((modifier) => {
                    const quantity = groupSelection[modifier.id] ?? 0;
                    const isOn = quantity > 0;
                    const blocked = optionBlocked(group, modifier.id);
                    return (
                      <div key={modifier.id} className="group relative min-w-0">
                        <HoldRepeatButton
                          intervalMs={2000}
                          doubleTapMs={320}
                          ariaLabel={`${modifier.name}، ${formatModifierDelta(modifier.priceDelta)}${
                            isOn ? `، ${toPersianDigits(quantity)} عدد انتخاب شده` : ""
                          }. ${MODIFIER_HOLD_HINT}`}
                          ariaPressed={isOn}
                          disabled={blocked}
                          onRepeat={() => repeatAdd(group, modifier.id)}
                          onDoubleTap={() => decrement(group, modifier.id)}
                          className={`flex min-h-11 w-full items-center justify-between gap-1 rounded-xl border px-2.5 py-1.5 text-start ${FOCUS} ${
                            isOn ? palette.optionSelected : palette.option
                          }`}
                        >
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate text-[13px] font-bold leading-5">
                              {modifier.name}
                              {quantity > 1 ? (
                                <span className="ms-1 font-black">×{toPersianDigits(quantity)}</span>
                              ) : null}
                            </span>
                            <span
                              className={`truncate text-[10px] leading-4 ${isOn ? "" : palette.chipPrice}`}
                            >
                              {formatModifierDelta(modifier.priceDelta)}
                              {quantity > 1 && modifier.priceDelta !== 0
                                ? ` × ${toPersianDigits(quantity)}`
                                : ""}
                            </span>
                          </span>
                        </HoldRepeatButton>
                        {/*
                          The accessible decrement. A double tap is a pointer
                          idiom with no keyboard or screen-reader equivalent,
                          so the same act gets a real button — hidden until it
                          is focused (or the option holds units and the pointer
                          hovers), which keeps the grid uncluttered without
                          leaving keyboard and AT users with an add-only
                          control.
                        */}
                        {isOn ? (
                          <button
                            type="button"
                            onClick={() => decrement(group, modifier.id)}
                            aria-label={`کاهش ${modifier.name}، اکنون ${toPersianDigits(quantity)} عدد`}
                            className={`absolute -top-1.5 flex size-7 items-center justify-center rounded-lg border border-border/80 bg-card text-muted-foreground opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100 sm:hover:opacity-100 ${FOCUS}`}
                            style={{ insetInlineEnd: "-0.375rem" }}
                          >
                            <MinusIcon className="size-3.5" aria-hidden="true" />
                          </button>
                        ) : null}
                      </div>
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
        </div>

        {/* Sticky footer: note → item quantity → price → actions. Everything
            the confirm decision needs stays on screen while the groups scroll
            beneath it. */}
        <div className="shrink-0 space-y-2.5 border-t border-border px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setNoteOpen(true)}
              className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed px-3 text-xs font-bold transition-colors hover:bg-muted ${FOCUS} ${
                note ? "border-amber-500 dark:border-amber-500/60 text-amber-700 dark:text-amber-300" : "border-border text-muted-foreground"
              }`}
            >
              <NotebookPenIcon className="size-4" aria-hidden="true" />
              {note ? <span className="truncate">«{note}»</span> : "افزودن یادداشت"}
              <span className="font-normal text-muted-foreground">(اختیاری)</span>
            </button>
            {selectQuantity ? (
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  aria-label="کاهش تعداد"
                  disabled={count <= 1}
                  onClick={() => setCount((value) => Math.max(1, value - 1))}
                  className={`flex size-11 items-center justify-center rounded-xl border border-input text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40 ${FOCUS}`}
                >
                  <MinusIcon className="size-5" aria-hidden="true" />
                </button>
                <span className="min-w-10 text-center text-xl font-bold text-foreground" aria-live="polite">
                  {toPersianDigits(count)}
                </span>
                <button
                  type="button"
                  aria-label="افزایش تعداد"
                  disabled={count >= MAX_ORDER_LINE_QUANTITY}
                  onClick={() => setCount((value) => value + 1)}
                  title={
                    count >= MAX_ORDER_LINE_QUANTITY
                      ? `حداکثر تعداد هر ردیف ${MAX_ORDER_LINE_QUANTITY} است`
                      : undefined
                  }
                  className={`flex size-11 items-center justify-center rounded-xl border border-input text-muted-foreground transition-colors hover:bg-muted disabled:opacity-40 ${FOCUS}`}
                >
                  <PlusIcon className="size-5" aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>

          {itemPrice !== undefined ? (
            <dl className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 rounded-xl border p-2.5 text-xs ${palette.surface}`}>
              <div className="flex gap-2 text-muted-foreground">
                <dt>قیمت پایه</dt>
                <dd className="font-bold">{money.format(breakdown.base)}</dd>
              </div>
              <div className="flex gap-2 text-muted-foreground">
                <dt>
                  افزودنی‌ها{chosenUnits > 0 ? ` (${toPersianDigits(chosenUnits)} عدد)` : ""}
                </dt>
                <dd className={`font-bold ${chosenUnits > 0 ? palette.accent : ""}`}>
                  {formatModifierDelta(breakdown.addOns)}
                </dd>
              </div>
              <div className="flex w-full justify-between border-t border-current/10 pt-1 text-sm font-bold text-foreground">
                <dt>
                  {effectiveQuantity > 1
                    ? `${money.format(breakdown.unit)} × ${toPersianDigits(effectiveQuantity)}`
                    : "جمع ردیف"}
                </dt>
                <dd>{money.format(breakdown.total)}</dd>
              </div>
            </dl>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className={`min-h-12 shrink-0 rounded-xl border border-input px-4 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted ${FOCUS}`}
            >
              انصراف
            </button>
            <button
              type="button"
              disabled={!canConfirm}
              onClick={confirm}
              className={`min-h-12 flex-1 rounded-xl px-4 text-sm font-bold transition duration-200 active:scale-[0.99] disabled:opacity-50 motion-reduce:transition-none ${FOCUS} ${palette.cta}`}
            >
              {canConfirm
                ? itemPrice !== undefined
                  ? `${confirmLabel ?? "افزودن"} — ${money.format(breakdown.total)}`
                  : (confirmLabel ?? "افزودن")
                : "ابتدا گروه‌های الزامی را انتخاب کنید"}
            </button>
          </div>
        </div>
      </DialogContent>

      {/* The note sheet — small on purpose: a text box, the item's own
          suggestions as one-tap chips, and done. */}
      <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>یادداشت سفارش</DialogTitle>
            <DialogDescription>خواستهٔ خاص مشتری برای «{itemName}»</DialogDescription>
          </DialogHeader>
          <textarea
            className="min-h-20 w-full rounded-xl border border-border/80 bg-muted p-3 text-sm text-foreground outline-none focus-visible:border-amber-500 dark:focus-visible:border-amber-500/60"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="مثلاً: بدون شکر"
            autoFocus
            dir="rtl"
          />
          {suggestions.length > 0 ? (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold text-muted-foreground">
                یادداشت‌های پرتکرار این آیتم
              </p>
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    aria-pressed={note.trim() === suggestion}
                    onClick={() => setNote(suggestion)}
                    className={`min-h-11 max-w-full truncate rounded-xl border px-3 text-xs font-bold transition-colors ${FOCUS} ${
                      note.trim() === suggestion
                        ? palette.optionSelected
                        : "border-border/80 bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : suggestionsLoading ? (
            <div className="flex flex-wrap gap-1.5" aria-busy="true" aria-label="در حال بارگذاری یادداشت‌های پیشنهادی">
              <span className="ops-skeleton h-11 w-28 rounded-xl" />
              <span className="ops-skeleton h-11 w-20 rounded-xl" />
              <span className="ops-skeleton h-11 w-24 rounded-xl" />
            </div>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            {note ? (
              <button
                type="button"
                onClick={() => setNote("")}
                className={`min-h-11 rounded-xl border border-input px-4 text-sm font-semibold text-muted-foreground transition-colors hover:bg-muted ${FOCUS}`}
              >
                پاک کردن
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setNoteOpen(false)}
              className={`min-h-11 rounded-xl bg-amber-500 dark:bg-amber-400 px-4 text-sm font-bold text-amber-950 ${FOCUS}`}
            >
              ثبت
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
