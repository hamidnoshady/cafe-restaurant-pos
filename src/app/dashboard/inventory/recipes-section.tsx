"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatQuantity } from "@/lib/digits";
import { api, Field, inputClass } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type {
  InventoryItem,
  MenuItemRef,
  ModifierRecipeLink,
  ModifierRef,
  RecipeLink,
  Runner,
} from "./inventory-manager";
import { EmptyState, SectionCard } from "../page-chrome";

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
  const inventoryOptions = useMemo(() => {
    return [
      { value: "", label: "قلم انبار را انتخاب کنید…" },
      ...items
        .filter((i) => i.is_active)
        .map((i) => ({
          value: i.id,
          label: `${i.name} (${i.unit})${i.is_produced ? " — ساخت داخلی" : ""}`,
          searchString: [i.name, i.sku, i.unit].filter(Boolean).join(" "),
        })),
    ];
  }, [items]);

  return (
    <div className="space-y-4 sm:space-y-5">
      <MenuItemRecipeCard
        items={items}
        inventoryOptions={inventoryOptions}
        menuItems={menuItems}
        recipes={recipes}
        busy={busy}
        run={run}
      />
      <ModifierRecipeCard
        items={items}
        inventoryOptions={inventoryOptions}
        modifiers={modifiers}
        modifierRecipes={modifierRecipes}
        busy={busy}
        run={run}
      />
    </div>
  );
}

function MenuItemRecipeCard({
  items,
  inventoryOptions,
  menuItems,
  recipes,
  busy,
  run,
}: {
  items: InventoryItem[];
  inventoryOptions: { value: string; label: string; searchString?: string }[];
  menuItems: MenuItemRef[];
  recipes: RecipeLink[];
  busy: boolean;
  run: Runner;
}) {
  const [menuItemId, setMenuItemId] = useState("");
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [quantity, setQuantity] = useState("");

  const lines = recipes.filter((r) => r.menu_item_id === menuItemId);

  const menuItemOptions = useMemo(() => {
    return [
      { value: "", label: "آیتم منو را انتخاب کنید…" },
      ...menuItems.map((m) => ({ value: m.id, label: m.name })),
    ];
  }, [menuItems]);

  function selectMenuItem(id: string) {
    setMenuItemId(id);
    // A previously selected ingredient is very easy to miss on a narrow screen.
    // Never carry it across menu items and accidentally add a line to the wrong recipe.
    setInventoryItemId("");
    setQuantity("");
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const qty = Number(quantity);
    if (!menuItemId || !inventoryItemId || !quantity.trim() || !Number.isFinite(qty) || qty <= 0)
      return;
    const ok = await run(() =>
      api("/api/inventory/recipes", {
        method: "POST",
        body: JSON.stringify({ menuItemId, inventoryItemId, quantity: qty }),
      }),
    );
    if (ok) setQuantity("");
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دستورالعمل مصرف</p>
          <h2 className="mt-1 font-semibold text-foreground">رسپی آیتم منو</h2>
        </div>
      }
      description="هر آیتم منو چه موادی مصرف می‌کند و به چه مقداری."
    >
      <Field label="آیتم منو">
        <SearchableSelect
          value={menuItemId}
          onChange={selectMenuItem}
          options={menuItemOptions}
        />
      </Field>

      {menuItemId ? (
        <>
          {lines.length === 0 ? (
            <EmptyState>هنوز مواد اولیه‌ای برای این آیتم ثبت نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 rounded-xl border border-border/80">
              {lines.map((l) => {
                const invItem = items.find((i) => i.id === l.inventory_item_id);
                return (
                  <li
                    key={l.inventory_item_id}
                    className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="break-words">
                      <span className="font-medium text-foreground">{invItem?.name ?? "?"}</span>
                      {" — "}
                      {formatQuantity(l.quantity)} {invItem?.unit}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `مادهٔ «${invItem?.name ?? ""}» از رسپی حذف شود؟`,
                          )
                        )
                          return;
                        void run(() =>
                          api(
                            `/api/inventory/recipes?menuItemId=${menuItemId}&inventoryItemId=${l.inventory_item_id}`,
                            { method: "DELETE" },
                          ),
                        );
                      }}
                    >
                      حذف
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <form
            onSubmit={add}
            className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            <Field label="قلم انبار">
              <SearchableSelect
                value={inventoryItemId}
                onChange={setInventoryItemId}
                options={inventoryOptions}
              />
            </Field>
            <Field label="مقدار مصرف برای یک واحد">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                placeholder="مثلاً ۱۸"
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={busy} size="lg" className="w-full px-5 font-semibold">
                ثبت
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </SectionCard>
  );
}

function ModifierRecipeCard({
  items,
  inventoryOptions,
  modifiers,
  modifierRecipes,
  busy,
  run,
}: {
  items: InventoryItem[];
  inventoryOptions: { value: string; label: string; searchString?: string }[];
  modifiers: ModifierRef[];
  modifierRecipes: ModifierRecipeLink[];
  busy: boolean;
  run: Runner;
}) {
  const [modifierId, setModifierId] = useState("");
  const [inventoryItemId, setInventoryItemId] = useState("");
  const [delta, setDelta] = useState("");

  const lines = modifierRecipes.filter((r) => r.modifier_id === modifierId);

  const modifierOptions = useMemo(() => {
    return [
      { value: "", label: "افزودنی را انتخاب کنید…" },
      ...modifiers.map((m) => ({
        value: m.id,
        label: `${m.group_name} — ${m.name}`,
      })),
    ];
  }, [modifiers]);

  function selectModifier(id: string) {
    setModifierId(id);
    // Do not retain an ingredient selected for another modifier.
    setInventoryItemId("");
    setDelta("");
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const qty = Number(delta);
    if (!modifierId || !inventoryItemId || !delta.trim() || !Number.isFinite(qty) || qty === 0)
      return;
    const ok = await run(() =>
      api("/api/inventory/modifier-recipes", {
        method: "POST",
        body: JSON.stringify({
          modifierId,
          inventoryItemId,
          quantityDelta: qty,
        }),
      }),
    );
    if (ok) setDelta("");
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دستورالعمل مصرف</p>
          <h2 className="mt-1 font-semibold text-foreground">اثر افزودنی‌ها بر مصرف مواد</h2>
        </div>
      }
      description="عدد مثبت یعنی مصرف اضافه (مثلاً «شات اضافه»)، عدد منفی یعنی کاهش/جایگزینی مادهٔ پایه (مثلاً «شیر بادام» جایگزین شیر معمولی)."
    >
      <Field label="افزودنی">
        <SearchableSelect
          value={modifierId}
          onChange={selectModifier}
          options={modifierOptions}
        />
      </Field>

      {modifierId ? (
        <>
          {lines.length === 0 ? (
            <EmptyState>هنوز اثری روی مواد ثبت نشده است.</EmptyState>
          ) : (
            <ul className="divide-y divide-border/80 rounded-xl border border-border/80">
              {lines.map((l) => {
                const invItem = items.find((i) => i.id === l.inventory_item_id);
                const value = Number(l.quantity_delta);
                return (
                  <li
                    key={l.inventory_item_id}
                    className="flex min-w-0 flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="break-words">
                      <span className="font-medium text-foreground">{invItem?.name ?? "?"}</span>
                      {" — "}
                      <span className={value > 0 ? "text-rose-700 dark:text-rose-300" : "text-emerald-700 dark:text-emerald-300"}>
                        {value > 0 ? "+" : ""}{formatQuantity(value)}
                      </span>
                      {" "}
                      {invItem?.unit}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      disabled={busy}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `اثر «${invItem?.name ?? ""}» از افزودنی حذف شود؟`,
                          )
                        )
                          return;
                        void run(() =>
                          api(
                            `/api/inventory/modifier-recipes?modifierId=${modifierId}&inventoryItemId=${l.inventory_item_id}`,
                            { method: "DELETE" },
                          ),
                        );
                      }}
                    >
                      حذف
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}

          <form
            onSubmit={add}
            className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          >
            <Field label="قلم انبار">
              <SearchableSelect
                value={inventoryItemId}
                onChange={setInventoryItemId}
                options={inventoryOptions}
              />
            </Field>
            <Field label="تغییر مقدار مصرف">
              <PersianNumberInput
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                value={delta}
                onChange={(e) => setDelta(e.target.value)}
                placeholder="منفی یا مثبت"
                required
              />
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={busy} size="lg" className="w-full px-5 font-semibold">
                ثبت
              </Button>
            </div>
          </form>
        </>
      ) : null}
    </SectionCard>
  );
}
