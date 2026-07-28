"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial } from "@/lib/money";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";

interface Category {
  id: string;
  name: string;
  tax_rate: string | number;
  is_active: boolean;
}
interface Item {
  id: string;
  category_id: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  price: string | number;
  is_active: boolean;
  target_margin_percent: string | number | null;
}
interface SuggestedPrice {
  materialCost: number;
  hasRecipe: boolean;
  overheadRatePercent: number | null;
  loadedCost: number;
  marginPercent: number | null;
  marginSource: "item" | "default" | "none";
  suggestedPrice: number | null;
  currentPrice: number;
}
interface ModifierGroup {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
}
interface Modifier {
  id: string;
  group_id: string;
  name: string;
  price_delta: string | number;
  is_active: boolean;
}
interface ItemGroupLink {
  menu_item_id: string;
  modifier_group_id: string;
}

interface MenuData {
  categories: Category[];
  items: Item[];
  modifierGroups: ModifierGroup[];
  modifiers: Modifier[];
  itemModifierGroups: ItemGroupLink[];
}

export function MenuManager() {
  const [data, setData] = useState<MenuData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<MenuData>("/api/menu").then(({ ok, data }) => {
      if (ok) setData(data);
    });
  }, []);
  useEffect(load, [load]);

  async function run(fn: () => Promise<{ ok: boolean; data: { error?: string } }>) {
    setBusy(true);
    setError("");
    const { ok, data } = await fn();
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return false;
    }
    load();
    return true;
  }

  if (!data) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-8">
      <ErrorBox>{error}</ErrorBox>
      <CategorySection data={data} busy={busy} run={run} />
      <ItemSection data={data} busy={busy} run={run} />
      <ModifierSection data={data} busy={busy} run={run} />
    </div>
  );
}

type Runner = (fn: () => Promise<{ ok: boolean; data: { error?: string } }>) => Promise<boolean>;

function CategorySection({ data, busy, run }: { data: MenuData; busy: boolean; run: Runner }) {
  const [name, setName] = useState("");

  async function add() {
    if (!name.trim()) return;
    const ok = await run(() => api("/api/menu/categories", { method: "POST", body: JSON.stringify({ name }) }));
    if (ok) setName("");
  }

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">دسته‌ها</h2>
      <div className="mb-4 flex gap-2">
        <input
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="نام دستهٔ جدید"
        />
        <SecondaryButton onClick={add} disabled={busy}>
          افزودن
        </SecondaryButton>
      </div>
      <ul className="divide-y divide-border">
        {data.categories.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2 text-sm">
            <span className={c.is_active ? "" : "text-muted-foreground line-through"}>
              {c.name} <span className="text-xs text-muted-foreground">(مالیات {toPersianDigits(c.tax_rate)}%)</span>
            </span>
            <SecondaryButton
              disabled={busy}
              onClick={() =>
                run(() =>
                  api(`/api/menu/categories/${c.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ isActive: !c.is_active }),
                  }),
                )
              }
            >
              {c.is_active ? "غیرفعال" : "فعال"}
            </SecondaryButton>
          </li>
        ))}
        {data.categories.length === 0 ? <p className="text-sm text-muted-foreground">دسته‌ای ثبت نشده است.</p> : null}
      </ul>
    </section>
  );
}

function ItemSection({ data, busy, run }: { data: MenuData; busy: boolean; run: Runner }) {
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    let priceRial: number;
    try {
      priceRial = parseToRial(price, "toman");
    } catch {
      return;
    }
    const ok = await run(() =>
      api("/api/menu/items", {
        method: "POST",
        body: JSON.stringify({ categoryId, name, price: priceRial }),
      }),
    );
    if (ok) {
      setName("");
      setPrice("");
    }
  }

  const activeCategories = data.categories.filter((c) => c.is_active);

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">آیتم‌ها</h2>
      <form onSubmit={add} className="mb-4 grid gap-2 sm:grid-cols-4">
        <select className={inputClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} required>
          <option value="">دسته…</option>
          {activeCategories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام آیتم" required />
        <input
          className={inputClass}
          dir="ltr"
          inputMode="numeric"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          placeholder="قیمت (تومان)"
          required
        />
        <PrimaryButton disabled={busy || activeCategories.length === 0}>افزودن آیتم</PrimaryButton>
      </form>

      <div className="space-y-4">
        {data.categories.map((c) => {
          const items = data.items.filter((i) => i.category_id === c.id);
          if (items.length === 0) return null;
          return (
            <div key={c.id}>
              <p className="mb-1 text-sm font-medium text-foreground">{c.name}</p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {items.map((i) => (
                  <ItemRow key={i.id} item={i} groups={data.modifierGroups} links={data.itemModifierGroups} busy={busy} run={run} />
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ItemRow({
  item,
  groups,
  links,
  busy,
  run,
}: {
  item: Item;
  groups: ModifierGroup[];
  links: ItemGroupLink[];
  busy: boolean;
  run: Runner;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const attached = new Set(links.filter((l) => l.menu_item_id === item.id).map((l) => l.modifier_group_id));

  return (
    <li className="px-4 py-2 text-sm">
      <div className="flex items-center justify-between">
        <span className={item.is_active ? "" : "text-muted-foreground line-through"}>{item.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">{formatToman(Number(item.price))}</span>
          <SecondaryButton onClick={() => setExpanded((v) => !v)}>افزودنی‌ها</SecondaryButton>
          <SecondaryButton onClick={() => setPricingOpen((v) => !v)}>قیمت پیشنهادی</SecondaryButton>
          <SecondaryButton
            disabled={busy}
            onClick={() =>
              run(() =>
                api(`/api/menu/items/${item.id}`, {
                  method: "PATCH",
                  body: JSON.stringify({ isActive: !item.is_active }),
                }),
              )
            }
          >
            {item.is_active ? "غیرفعال" : "فعال"}
          </SecondaryButton>
        </div>
      </div>
      {pricingOpen ? <PricingPanel item={item} busy={busy} run={run} /> : null}
      {expanded ? (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-border pt-2">
          {groups.length === 0 ? (
            <span className="text-xs text-muted-foreground">گروه افزودنی‌ای ثبت نشده است.</span>
          ) : (
            groups.map((g) => {
              const isOn = attached.has(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(() =>
                      isOn
                        ? api(
                            `/api/menu/item-modifier-groups?menuItemId=${item.id}&modifierGroupId=${g.id}`,
                            { method: "DELETE" },
                          )
                        : api("/api/menu/item-modifier-groups", {
                            method: "POST",
                            body: JSON.stringify({ menuItemId: item.id, modifierGroupId: g.id }),
                          }),
                    )
                  }
                  className={`rounded-full border px-3 py-1 text-xs ${
                    isOn ? "border-primary/40 bg-primary/5 text-primary" : "border-input text-muted-foreground"
                  }`}
                >
                  {g.name}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Cost-plus pricing advisory: material cost (from the recipe) + ledger-derived overhead, target margin -> a suggested price the owner can apply or ignore. */
function PricingPanel({ item, busy, run }: { item: Item; busy: boolean; run: Runner }) {
  const [suggestion, setSuggestion] = useState<SuggestedPrice | null>(null);
  const [loading, setLoading] = useState(true);
  const [marginInput, setMarginInput] = useState(
    item.target_margin_percent != null ? String(item.target_margin_percent) : "",
  );

  const load = useCallback(() => {
    setLoading(true);
    api<{ suggestion: SuggestedPrice }>(`/api/menu/items/${item.id}/suggested-price`).then(({ ok, data }) => {
      setSuggestion(ok ? data.suggestion : null);
      setLoading(false);
    });
  }, [item.id]);

  useEffect(() => {
    load();
  }, [load, item.price, item.target_margin_percent]);

  async function saveMargin() {
    const trimmed = marginInput.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value >= 100)) return;
    await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ targetMarginPercent: value }),
      }),
    );
  }

  async function applySuggestedPrice() {
    if (suggestion?.suggestedPrice == null) return;
    await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ price: suggestion.suggestedPrice }),
      }),
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-muted/40 p-3 text-xs">
      {loading ? (
        <p className="text-muted-foreground">در حال محاسبه…</p>
      ) : !suggestion ? (
        <p className="text-muted-foreground">محاسبه ممکن نشد.</p>
      ) : (
        <>
          {!suggestion.hasRecipe ? (
            <p className="text-muted-foreground">دستورالعمل مصرف (رسپی) این آیتم ثبت نشده؛ بهای مواد قابل محاسبه نیست.</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <span className="text-muted-foreground">بهای مواد: {formatToman(suggestion.materialCost)}</span>
              <span className="text-muted-foreground">
                سربار: {suggestion.overheadRatePercent != null ? `${toPersianDigits(Math.round(suggestion.overheadRatePercent))}٪` : "بدون داده"}
              </span>
              <span className="text-muted-foreground">بهای تمام‌شده: {formatToman(suggestion.loadedCost)}</span>
              <span className="text-muted-foreground">
                حاشیه سود:{" "}
                {suggestion.marginPercent != null
                  ? `${toPersianDigits(suggestion.marginPercent)}٪ (${
                      suggestion.marginSource === "item" ? "اختصاصی" : "پیش‌فرض"
                    })`
                  : "تعیین‌نشده"}
              </span>
            </div>
          )}
          {suggestion.hasRecipe && suggestion.suggestedPrice != null ? (
            <div className="flex items-center justify-between rounded-md bg-card px-2 py-1.5">
              <span className="font-medium">قیمت پیشنهادی: {formatToman(suggestion.suggestedPrice)}</span>
              <SecondaryButton disabled={busy} onClick={applySuggestedPrice}>
                اعمال قیمت
              </SecondaryButton>
            </div>
          ) : suggestion.hasRecipe ? (
            <p className="text-muted-foreground">
              برای پیشنهاد قیمت، ابتدا هدف حاشیه سود را (در تنظیمات یا برای همین آیتم) مشخص کنید.
            </p>
          ) : null}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
        <span className="text-muted-foreground">حاشیه سود اختصاصی این آیتم:</span>
        <input
          className={`${inputClass} w-24`}
          dir="ltr"
          inputMode="decimal"
          value={marginInput}
          onChange={(e) => setMarginInput(e.target.value)}
          placeholder="پیش‌فرض"
        />
        <SecondaryButton disabled={busy} onClick={saveMargin}>
          ذخیره
        </SecondaryButton>
      </div>
    </div>
  );
}

function ModifierSection({ data, busy, run }: { data: MenuData; busy: boolean; run: Runner }) {
  const [groupName, setGroupName] = useState("");
  const [minSelect, setMinSelect] = useState("0");
  const [maxSelect, setMaxSelect] = useState("1");

  async function addGroup() {
    if (!groupName.trim()) return;
    const ok = await run(() =>
      api("/api/menu/modifier-groups", {
        method: "POST",
        body: JSON.stringify({ name: groupName, minSelect: Number(minSelect), maxSelect: Number(maxSelect) }),
      }),
    );
    if (ok) {
      setGroupName("");
      setMinSelect("0");
      setMaxSelect("1");
    }
  }

  return (
    <section className="rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-3 font-semibold">گروه‌های افزودنی</h2>
      <div className="mb-4 grid gap-2 sm:grid-cols-4">
        <input className={inputClass} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="نام گروه (مثلاً «نوع شیر»)" />
        <input className={inputClass} dir="ltr" inputMode="numeric" value={minSelect} onChange={(e) => setMinSelect(e.target.value)} placeholder="حداقل انتخاب" />
        <input className={inputClass} dir="ltr" inputMode="numeric" value={maxSelect} onChange={(e) => setMaxSelect(e.target.value)} placeholder="حداکثر انتخاب" />
        <SecondaryButton onClick={addGroup} disabled={busy}>
          افزودن گروه
        </SecondaryButton>
      </div>

      <div className="space-y-4">
        {data.modifierGroups.map((g) => (
          <ModifierGroupRow key={g.id} group={g} modifiers={data.modifiers.filter((m) => m.group_id === g.id)} busy={busy} run={run} />
        ))}
        {data.modifierGroups.length === 0 ? <p className="text-sm text-muted-foreground">گروهی ثبت نشده است.</p> : null}
      </div>
    </section>
  );
}

function ModifierGroupRow({
  group,
  modifiers,
  busy,
  run,
}: {
  group: ModifierGroup;
  modifiers: Modifier[];
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");
  const [delta, setDelta] = useState("0");

  async function addModifier() {
    if (!name.trim()) return;
    let deltaRial: number;
    try {
      deltaRial = parseToRial(delta || "0", "toman");
    } catch {
      return;
    }
    const ok = await run(() =>
      api("/api/menu/modifiers", {
        method: "POST",
        body: JSON.stringify({ groupId: group.id, name, priceDelta: deltaRial }),
      }),
    );
    if (ok) {
      setName("");
      setDelta("0");
    }
  }

  return (
    <div className="rounded-lg border border-border p-3">
      <p className="mb-2 text-sm font-medium">
        {group.name}{" "}
        <span className="text-xs text-muted-foreground">
          (انتخاب {toPersianDigits(group.min_select)} تا {toPersianDigits(group.max_select)})
        </span>
      </p>
      <ul className="mb-2 divide-y divide-border">
        {modifiers.map((m) => (
          <li key={m.id} className="flex items-center justify-between py-1.5 text-sm">
            <span className={m.is_active ? "" : "text-muted-foreground line-through"}>{m.name}</span>
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">{formatToman(Number(m.price_delta))}</span>
              <SecondaryButton
                disabled={busy}
                onClick={() =>
                  run(() =>
                    api(`/api/menu/modifiers/${m.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ isActive: !m.is_active }),
                    }),
                  )
                }
              >
                {m.is_active ? "غیرفعال" : "فعال"}
              </SecondaryButton>
            </div>
          </li>
        ))}
        {modifiers.length === 0 ? <p className="py-1 text-xs text-muted-foreground">افزودنی‌ای ثبت نشده است.</p> : null}
      </ul>
      <div className="flex gap-2">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام افزودنی" />
        <input className={inputClass} dir="ltr" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="مبلغ اضافه (تومان)" />
        <SecondaryButton onClick={addModifier} disabled={busy}>
          افزودن
        </SecondaryButton>
      </div>
    </div>
  );
}
