"use client";

import { useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { inputClass, PrimaryButton, SecondaryButton } from "./ui";

export interface ModifierGroupWithModifiers {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  modifiers: { id: string; name: string; price_delta: string | number }[];
}

/** Modal for picking modifiers (respecting each group's min/max select) before adding an item to a cart/order. */
export function ModifierPicker({
  itemName,
  groups,
  onCancel,
  onConfirm,
}: {
  itemName: string;
  groups: ModifierGroupWithModifiers[];
  onCancel: () => void;
  onConfirm: (modifierIds: string[], note: string) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [note, setNote] = useState("");

  function toggle(group: ModifierGroupWithModifiers, modifierId: string) {
    setSelected((prev) => {
      const current = prev[group.id] ?? [];
      if (group.max_select === 1) {
        return { ...prev, [group.id]: current.includes(modifierId) ? [] : [modifierId] };
      }
      if (current.includes(modifierId)) {
        return { ...prev, [group.id]: current.filter((id) => id !== modifierId) };
      }
      if (current.length >= group.max_select) return prev;
      return { ...prev, [group.id]: [...current, modifierId] };
    });
  }

  const canConfirm = groups.every((g) => {
    const n = (selected[g.id] ?? []).length;
    return n >= g.min_select && n <= g.max_select;
  });

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/30 p-4" onClick={onCancel}>
      <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="mb-4 font-semibold">{itemName}</h3>
        {groups.map((g) => (
          <div key={g.id} className="mb-4">
            <p className="mb-2 text-sm font-medium text-stone-700">
              {g.name}{" "}
              <span className="text-xs text-stone-400">
                (انتخاب {toPersianDigits(g.min_select)} تا {toPersianDigits(g.max_select)})
              </span>
            </p>
            <div className="flex flex-wrap gap-2">
              {g.modifiers.map((m) => {
                const isOn = (selected[g.id] ?? []).includes(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(g, m.id)}
                    className={`rounded-full border px-3 py-1.5 text-xs ${
                      isOn ? "border-amber-500 bg-amber-50 text-amber-800" : "border-stone-300 text-stone-600"
                    }`}
                  >
                    {m.name}
                    {Number(m.price_delta) !== 0 ? ` (${formatToman(Number(m.price_delta))})` : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        <input className={`${inputClass} mb-4`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="یادداشت (اختیاری)" />
        <div className="flex justify-end gap-2">
          <SecondaryButton onClick={onCancel}>انصراف</SecondaryButton>
          <PrimaryButton
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm(groups.flatMap((g) => selected[g.id] ?? []), note.trim())}
          >
            افزودن
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
