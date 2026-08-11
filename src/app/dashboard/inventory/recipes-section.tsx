"use client";

import { useState } from "react";
import { formatQuantity } from "@/lib/digits";
import { api, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  InventoryItem,
  MenuItemRef,
  ModifierRecipeLink,
  ModifierRef,
  RecipeLink,
  Runner,
} from "./inventory-manager";

export function RecipesSection({
  items,
  menuItems,
  modifiers,
  recipes,
  modifierRecipes,
  busy,
  run,
}: {
  items: InventoryItem[];
  menuItems: MenuItemRef[];
  modifiers: ModifierRef[];
  recipes: RecipeLink[];
  modifierRecipes: ModifierRecipeLink[];
  busy: boolean;
  run: Runner;
}) {
  return (
    <div className="space-y-6">
      <MenuItemRecipeCard items={items} menuItems={menuItems} recipes={recipes} busy={busy} run={run} />
      <ModifierRecipeCard items={items} modifiers={modifiers} modifierRecipes={modifierRecipes} busy={busy} run={run} />
    </div>
  );
}

function MenuItemRecipeCard({
  items,
  menuItems,
  recipes,
  busy,
  run,
}: {
  items: InventoryItem[];
  menuItems: MenuItemRef[];
  recipes: RecipeLink[];
  busy: boolean;
  run: Runner;
}) {
  const [menuItemId, setMenuItemId] = useState("");
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [quantity, setQuantity] = useState("");

  const lines = recipes.filter((r) => r.menu_item_id === menuItemId);
  const activeItems = items.filter((i) => i.is_active);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const qty = Number(quantity);
    if (!menuItemId || !inventoryItemId || !Number.isFinite(qty) || qty <= 0) return;
    const ok = await run(() =>
      api("/api/inventory/recipes", {
        method: "POST",
        body: JSON.stringify({ menuItemId, inventoryItemId, quantity: qty }),
      }),
    );
    if (ok) setQuantity("");
  }

  return (
    <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">دستورالعمل مصرف آیتم منو (رسپی)</h2>
      <Field label="آیتم منو">
        <SearchableSelect
          value={menuItemId}
          onChange={setMenuItemId}
          options={[
            { value: "", label: "آیتم منو را انتخاب کنید…" },
            ...menuItems.map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
      </Field>

      {menuItemId ? (
        <>
          <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
            {lines.map((l) => {
              const invItem = items.find((i) => i.id === l.inventory_item_id);
              return (
                <li key={l.inventory_item_id} className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="break-words">
                    {invItem?.name ?? "?"} — {formatQuantity(l.quantity)} {invItem?.unit}
                  </span>
                  <SecondaryButton
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`مادهٔ «${invItem?.name ?? ""}» از رسپی حذف شود؟`)) return;
                      void run(() =>
                        api(
                          `/api/inventory/recipes?menuItemId=${menuItemId}&inventoryItemId=${l.inventory_item_id}`,
                          { method: "DELETE" },
                        ),
                      );
                    }}
                  >
                    حذف
                  </SecondaryButton>
                </li>
              );
            })}
            {lines.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">هنوز مواد اولیه‌ای ثبت نشده است.</li> : null}
          </ul>
          <form onSubmit={add} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="قلم انبار">
              <SearchableSelect
                value={inventoryItemId}
                onChange={setInventoryItemId}
                options={[
                  { value: "", label: "قلم انبار را انتخاب کنید…" },
                  ...activeItems.map((i) => ({
                    value: i.id,
                    label: `${i.name} (${i.unit})`,
                    searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                  })),
                ]}
              />
            </Field>
            <Field label="مقدار مصرف برای یک واحد">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="مثلاً ۱۸"
                required
              />
            </Field>
            <div className="mb-4 flex items-end">
              <PrimaryButton disabled={busy}>ثبت</PrimaryButton>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}

function ModifierRecipeCard({
  items,
  modifiers,
  modifierRecipes,
  busy,
  run,
}: {
  items: InventoryItem[];
  modifiers: ModifierRef[];
  modifierRecipes: ModifierRecipeLink[];
  busy: boolean;
  run: Runner;
}) {
  const [modifierId, setModifierId] = useState("");
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [delta, setDelta] = useState("");

  const lines = modifierRecipes.filter((r) => r.modifier_id === modifierId);
  const activeItems = items.filter((i) => i.is_active);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const qty = Number(delta);
    if (!modifierId || !inventoryItemId || !Number.isFinite(qty) || qty === 0) return;
    const ok = await run(() =>
      api("/api/inventory/modifier-recipes", {
        method: "POST",
        body: JSON.stringify({ modifierId, inventoryItemId, quantityDelta: qty }),
      }),
    );
    if (ok) setDelta("");
  }

  return (
    <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-1 font-semibold">اثر افزودنی‌ها بر مصرف مواد</h2>
      <p className="mb-3 text-xs text-muted-foreground">
        عدد مثبت یعنی مصرف اضافه (مثلاً «شات اضافه»)، عدد منفی یعنی کاهش/جایگزینی مادهٔ پایه (مثلاً «شیر بادام» جایگزین شیر معمولی).
      </p>
      <Field label="افزودنی">
        <SearchableSelect
          value={modifierId}
          onChange={setModifierId}
          options={[
            { value: "", label: "افزودنی را انتخاب کنید…" },
            ...modifiers.map((m) => ({ value: m.id, label: `${m.group_name} — ${m.name}` })),
          ]}
        />
      </Field>

      {modifierId ? (
        <>
          <ul className="mb-3 divide-y divide-border rounded-lg border border-border">
            {lines.map((l) => {
              const invItem = items.find((i) => i.id === l.inventory_item_id);
              const value = Number(l.quantity_delta);
              return (
                <li key={l.inventory_item_id} className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <span className="break-words">
                    {invItem?.name ?? "?"} — {value > 0 ? "+" : ""}
                    {formatQuantity(value)} {invItem?.unit}
                  </span>
                  <SecondaryButton
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(`اثر «${invItem?.name ?? ""}» از افزودنی حذف شود؟`)) return;
                      void run(() =>
                        api(
                          `/api/inventory/modifier-recipes?modifierId=${modifierId}&inventoryItemId=${l.inventory_item_id}`,
                          { method: "DELETE" },
                        ),
                      );
                    }}
                  >
                    حذف
                  </SecondaryButton>
                </li>
              );
            })}
            {lines.length === 0 ? <li className="px-3 py-2 text-xs text-muted-foreground">هنوز اثری روی مواد ثبت نشده است.</li> : null}
          </ul>
          <form onSubmit={add} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Field label="قلم انبار">
              <SearchableSelect
                value={inventoryItemId}
                onChange={setInventoryItemId}
                options={[
                  { value: "", label: "قلم انبار را انتخاب کنید…" },
                  ...activeItems.map((i) => ({
                    value: i.id,
                    label: `${i.name} (${i.unit})`,
                    searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
                  })),
                ]}
              />
            </Field>
            <Field label="تغییر مقدار مصرف">
              <input
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder="منفی یا مثبت"
                required
              />
            </Field>
            <div className="mb-4 flex items-end">
              <PrimaryButton disabled={busy}>ثبت</PrimaryButton>
            </div>
          </form>
        </>
      ) : null}
    </section>
  );
}
