"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  useCallback,
  useEffect,
  useState,
  useDeferredValue,
  useMemo,
} from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  inputClass,
  PrimaryButton,
  SecondaryButton,
} from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ChevronDown } from "lucide-react";
import { SectionCard } from "../page-chrome";

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
  overheadSource: "ledger" | "fallback" | "none";
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

  async function run(
    fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
  ) {
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

  if (!data)
    return <LoadingSkeleton rows={3} />;

  return (
    <div className="space-y-8">
      <ErrorBox>{error}</ErrorBox>
      <CategorySection data={data} busy={busy} run={run} />
      <ItemSection data={data} busy={busy} run={run} />
      <ModifierSection data={data} busy={busy} run={run} />
    </div>
  );
}

type Runner = (
  fn: () => Promise<{ ok: boolean; data: { error?: string } }>,
) => Promise<boolean>;

function CategorySection({
  data,
  busy,
  run,
}: {
  data: MenuData;
  busy: boolean;
  run: Runner;
}) {
  const [name, setName] = useState("");

  async function add() {
    if (!name.trim()) return;
    const ok = await run(() =>
      api("/api/menu/categories", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    );
    if (ok) setName("");
  }

  return (
    <SectionCard title="دسته‌ها">
      <form
        className="mb-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <Field label="نام دسته">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="مثلاً نوشیدنی گرم"
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton onClick={add} disabled={busy}>
            افزودن
          </SecondaryButton>
        </div>
      </form>
      <ul className="divide-y divide-border">
        {data.categories.map((c) => (
          <li
            key={c.id}
            className="flex min-w-0 flex-col gap-2 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
          >
            <span
              className={`min-w-0 break-words ${c.is_active ? "" : "text-muted-foreground line-through"}`}
            >
              {c.name}{" "}
              <span className="text-xs text-muted-foreground">
                (مالیات {toPersianDigits(c.tax_rate)}%)
              </span>
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
        {data.categories.length === 0 ? (
          <p className="text-sm text-muted-foreground">دسته‌ای ثبت نشده است.</p>
        ) : null}
      </ul>
    </SectionCard>
  );
}

function ItemSection({
  data,
  busy,
  run,
}: {
  data: MenuData;
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [categoryId, setCategoryId] = useState("");
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(
    () => new Set(),
  );

  function toggleCategory(id: string) {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    let priceRial: number;
    try {
      priceRial = money.parse(price);
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

  // ⚡ Bolt: Extract expensive O(n) string computations (like lowercase)
  // out of the hot rendering loop. This memoizes the normalized text based on the
  // data.items array instead of per-keystroke.
  const searchableItems = useMemo(() => {
    return data.items.map((i) => {
      return {
        item: i,
        nameLower: i.name.toLowerCase(),
        skuLower: i.sku ? i.sku.toLowerCase() : "",
      };
    });
  }, [data.items]);

  // ⚡ Bolt: Filter the pre-computed strings with a fast .includes() check
  const filteredItems = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return data.items;
    return searchableItems
      .filter(
        (si) =>
          si.nameLower.includes(q) || (si.skuLower && si.skuLower.includes(q)),
      )
      .map((si) => si.item);
  }, [searchableItems, deferredQuery, data.items]);

  return (
    <SectionCard title="آیتم‌ها">
      <form
        onSubmit={add}
        className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4"
      >
        <Field label="دسته">
          <SearchableSelect
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: "", label: "دسته را انتخاب کنید…" },
              ...activeCategories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>
        <Field label="نام آیتم">
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </Field>
        <Field label={`قیمت (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            required
          />
        </Field>
        <div className="mb-4 flex items-end">
          <PrimaryButton disabled={busy || activeCategories.length === 0}>
            افزودن آیتم
          </PrimaryButton>
        </div>
      </form>

      <input
        className={inputClass}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="جستجوی آیتم…"
        aria-label="جستجوی آیتم"
      />
      <div className="space-y-4">
        {data.categories.map((c) => {
          const items = filteredItems.filter((i) => i.category_id === c.id);
          if (items.length === 0) return null;
          const isCollapsed = collapsedCategories.has(c.id);
          return (
            <div key={c.id}>
              <button
                type="button"
                onClick={() => toggleCategory(c.id)}
                className="mb-1 flex items-center gap-1.5 text-sm font-medium text-stone-950"
                aria-expanded={!isCollapsed}
              >
                <ChevronDown
                  className={`size-4 text-muted-foreground transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
                  aria-hidden="true"
                />
                {c.name}
                <span className="text-xs font-normal text-muted-foreground">
                  ({toPersianDigits(items.length)})
                </span>
              </button>
              {isCollapsed ? null : (
                <ul className="divide-y divide-stone-200/80 rounded-xl border border-stone-200/80">
                  {items.map((i) => (
                    <ItemRow
                      key={i.id}
                      item={i}
                      categories={data.categories}
                      groups={data.modifierGroups}
                      links={data.itemModifierGroups}
                      busy={busy}
                      run={run}
                    />
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function ItemRow({
  item,
  categories,
  groups,
  links,
  busy,
  run,
}: {
  item: Item;
  categories: Category[];
  groups: ModifierGroup[];
  links: ItemGroupLink[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [expanded, setExpanded] = useState(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const attached = new Set(
    links
      .filter((l) => l.menu_item_id === item.id)
      .map((l) => l.modifier_group_id),
  );

  if (editing) {
    return (
      <EditItemRow
        item={item}
        categories={categories}
        busy={busy}
        run={run}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <li className="min-w-0 px-4 py-3 text-sm">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span
          className={`min-w-0 break-words ${item.is_active ? "" : "text-muted-foreground line-through"}`}
        >
          {item.name}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">
            {money.format(Number(item.price))}
          </span>
          <SecondaryButton disabled={busy} onClick={() => setEditing(true)}>
            ویرایش
          </SecondaryButton>
          <SecondaryButton onClick={() => setExpanded((v) => !v)}>
            افزودنی‌ها
          </SecondaryButton>
          <SecondaryButton onClick={() => setPricingOpen((v) => !v)}>
            قیمت پیشنهادی
          </SecondaryButton>
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
          <SecondaryButton
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `آیتم منوی «${item.name}» حذف شود؟ آیتمی که در سفارش استفاده شده باشد غیرفعال می‌شود.`,
                )
              )
                return;
              void run(() =>
                api(`/api/menu/items/${item.id}`, { method: "DELETE" }),
              );
            }}
          >
            حذف
          </SecondaryButton>
        </div>
      </div>
      {pricingOpen ? <PricingPanel item={item} busy={busy} run={run} /> : null}
      {expanded ? (
        <div className="mt-2 flex flex-wrap gap-2 border-t border-stone-200/80 pt-2">
          {groups.length === 0 ? (
            <span className="text-xs text-muted-foreground">
              گروه افزودنی‌ای ثبت نشده است.
            </span>
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
                            body: JSON.stringify({
                              menuItemId: item.id,
                              modifierGroupId: g.id,
                            }),
                          }),
                    )
                  }
                  aria-pressed={isOn}
                  className={`min-h-9 rounded-lg border px-3 text-xs font-medium transition-colors ${
                    isOn
                      ? "border-amber-200 bg-amber-100 text-amber-950"
                      : "border-stone-200 text-stone-600 hover:bg-stone-50"
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

function EditItemRow({
  item,
  categories,
  busy,
  run,
  onDone,
}: {
  item: Item;
  categories: Category[];
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [categoryId, setCategoryId] = useState(item.category_id ?? "");
  const [name, setName] = useState(item.name);
  const [price, setPrice] = useState(String(money.toInput(Number(item.price))));
  const selectableCategories = categories.filter(
    (category) => category.is_active || category.id === item.category_id,
  );

  async function save(event: React.FormEvent) {
    event.preventDefault();
    let priceRial: number;
    try {
      priceRial = money.parse(price);
    } catch {
      return;
    }
    if (!categoryId || !name.trim()) return;
    const ok = await run(() =>
      api(`/api/menu/items/${item.id}`, {
        method: "PATCH",
        body: JSON.stringify({ categoryId, name, price: priceRial }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="px-4 py-3">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        <Field label="دسته">
          <SearchableSelect
            value={categoryId}
            onChange={setCategoryId}
            options={[
              { value: "", label: "دسته را انتخاب کنید…" },
              ...selectableCategories.map((category) => ({
                value: category.id,
                label: category.name,
              })),
            ]}
          />
        </Field>
        <Field label="نام آیتم">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={`قیمت (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            required
          />
        </Field>
        <div className="flex flex-col gap-2 sm:col-span-2 xl:col-span-3 sm:flex-row">
          <div className="w-full sm:w-40">
            <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          </div>
          <SecondaryButton disabled={busy} onClick={onDone}>
            انصراف
          </SecondaryButton>
        </div>
      </form>
    </li>
  );
}

/** Cost-plus pricing advisory: material cost (from the recipe) + ledger-derived overhead, target margin -> a suggested price the owner can apply or ignore. */
function PricingPanel({
  item,
  busy,
  run,
}: {
  item: Item;
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [suggestion, setSuggestion] = useState<SuggestedPrice | null>(null);
  const [loading, setLoading] = useState(true);
  const [marginInput, setMarginInput] = useState(
    item.target_margin_percent != null
      ? String(item.target_margin_percent)
      : "",
  );

  const load = useCallback(() => {
    setLoading(true);
    void api<{ suggestion: SuggestedPrice }>(
      `/api/menu/items/${item.id}/suggested-price`,
    )
      .then(({ ok, data }) => setSuggestion(ok ? data.suggestion : null))
      .catch(() => setSuggestion(null))
      .finally(() => setLoading(false));
  }, [item.id]);

  useEffect(() => {
    load();
  }, [load, item.price, item.target_margin_percent]);

  async function saveMargin() {
    const trimmed = marginInput.trim();
    const value = trimmed === "" ? null : Number(trimmed);
    if (
      value !== null &&
      (!Number.isFinite(value) || value < 0 || value >= 100)
    )
      return;
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
    <div className="mt-2 space-y-2 rounded-xl border border-stone-200/80 bg-stone-50/60 p-3 text-xs">
      {loading ? (
        <LoadingSkeleton rows={2} compact label="در حال محاسبه قیمت پیشنهادی" />
      ) : !suggestion ? (
        <p className="text-muted-foreground">محاسبه ممکن نشد.</p>
      ) : (
        <>
          {!suggestion.hasRecipe ? (
            <p className="text-muted-foreground">
              دستورالعمل مصرف (رسپی) این آیتم ثبت نشده؛ بهای مواد قابل محاسبه
              نیست.
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              <span className="text-muted-foreground">
                بهای مواد: {money.format(suggestion.materialCost)}
              </span>
              <span className="text-muted-foreground">
                سربار:{" "}
                {suggestion.overheadRatePercent != null
                  ? `${toPersianDigits(Math.round(suggestion.overheadRatePercent))}٪ (${
                      suggestion.overheadSource === "ledger"
                        ? "بر اساس دفتر"
                        : "برآورد دستی"
                    })`
                  : "بدون داده"}
              </span>
              <span className="text-muted-foreground">
                بهای تمام‌شده: {money.format(suggestion.loadedCost)}
              </span>
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
            <div className="flex flex-col gap-2 rounded-md bg-card px-2 py-1.5 sm:flex-row sm:items-center sm:justify-between">
              <span className="font-medium">
                قیمت پیشنهادی: {money.format(suggestion.suggestedPrice)}
              </span>
              <SecondaryButton disabled={busy} onClick={applySuggestedPrice}>
                اعمال قیمت
              </SecondaryButton>
            </div>
          ) : suggestion.hasRecipe ? (
            <p className="text-muted-foreground">
              برای پیشنهاد قیمت، ابتدا هدف حاشیه سود را (در تنظیمات یا برای همین
              آیتم) مشخص کنید.
            </p>
          ) : null}
        </>
      )}

      <div className="grid min-w-0 gap-2 border-t border-stone-200/80 pt-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <Field label="حاشیه سود اختصاصی این آیتم (درصد)">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="decimal"
            value={marginInput}
            onChange={(e) => setMarginInput(e.target.value)}
            placeholder="پیش‌فرض"
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton disabled={busy} onClick={saveMargin}>
            ذخیره
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

function ModifierSection({
  data,
  busy,
  run,
}: {
  data: MenuData;
  busy: boolean;
  run: Runner;
}) {
  const [groupName, setGroupName] = useState("");
  const [minSelect, setMinSelect] = useState("0");
  const [maxSelect, setMaxSelect] = useState("1");

  async function addGroup() {
    if (!groupName.trim()) return;
    const ok = await run(() =>
      api("/api/menu/modifier-groups", {
        method: "POST",
        body: JSON.stringify({
          name: groupName,
          minSelect: Number(minSelect),
          maxSelect: Number(maxSelect),
        }),
      }),
    );
    if (ok) {
      setGroupName("");
      setMinSelect("0");
      setMaxSelect("1");
    }
  }

  return (
    <SectionCard title="گروه‌های افزودنی">
      <form
        className="mb-4 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4"
        onSubmit={(event) => {
          event.preventDefault();
          void addGroup();
        }}
      >
        <Field label="نام گروه">
          <input
            className={inputClass}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="مثلاً نوع شیر"
          />
        </Field>
        <Field label="حداقل انتخاب">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={minSelect}
            onChange={(e) => setMinSelect(e.target.value)}
          />
        </Field>
        <Field label="حداکثر انتخاب">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={maxSelect}
            onChange={(e) => setMaxSelect(e.target.value)}
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton onClick={addGroup} disabled={busy}>
            افزودن گروه
          </SecondaryButton>
        </div>
      </form>

      <div className="space-y-4">
        {data.modifierGroups.map((g) => (
          <ModifierGroupRow
            key={g.id}
            group={g}
            groups={data.modifierGroups}
            modifiers={data.modifiers.filter((m) => m.group_id === g.id)}
            busy={busy}
            run={run}
          />
        ))}
        {data.modifierGroups.length === 0 ? (
          <p className="text-sm text-muted-foreground">گروهی ثبت نشده است.</p>
        ) : null}
      </div>
    </SectionCard>
  );
}

function ModifierGroupRow({
  group,
  groups,
  modifiers,
  busy,
  run,
}: {
  group: ModifierGroup;
  /** Every group of the branch — the edit row lets an addon be moved to any of them. */
  groups: ModifierGroup[];
  modifiers: Modifier[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [modifierName, setModifierName] = useState("");
  const [modifierDelta, setModifierDelta] = useState("0");
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(group.name);
  const [editMin, setEditMin] = useState(String(group.min_select));
  const [editMax, setEditMax] = useState(String(group.max_select));

  async function addModifier() {
    if (!modifierName.trim()) return;
    let deltaRial: number;
    try {
      deltaRial = money.parse(modifierDelta || "0");
    } catch {
      return;
    }
    const ok = await run(() =>
      api("/api/menu/modifiers", {
        method: "POST",
        body: JSON.stringify({
          groupId: group.id,
          name: modifierName,
          priceDelta: deltaRial,
        }),
      }),
    );
    if (ok) {
      setModifierName("");
      setModifierDelta("0");
    }
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const min = Number(editMin);
    const max = Number(editMax);
    if (
      !editName.trim() ||
      !Number.isInteger(min) ||
      !Number.isInteger(max) ||
      min < 0 ||
      max < 1 ||
      min > max
    ) {
      return;
    }
    const ok = await run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          minSelect: min,
          maxSelect: max,
        }),
      }),
    );
    if (ok) setEditing(false);
  }

  function removeGroup() {
    if (
      !window.confirm(
        `گروه افزودنی «${group.name}» و همهٔ افزودنی‌هایش حذف شود؟`,
      )
    )
      return;
    void run(() =>
      api(`/api/menu/modifier-groups/${group.id}`, { method: "DELETE" }),
    );
  }

  return (
    <div className="min-w-0 rounded-xl border border-stone-200/80 p-3">
      {editing ? (
        <form
          className="mb-2 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          onSubmit={save}
        >
          <Field label="نام گروه">
            <input
              className={inputClass}
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              required
            />
          </Field>
          <Field label="حداقل انتخاب">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={editMin}
              onChange={(e) => setEditMin(e.target.value)}
              required
            />
          </Field>
          <Field label="حداکثر انتخاب">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={editMax}
              onChange={(e) => setEditMax(e.target.value)}
              required
            />
          </Field>
          <div className="flex items-end gap-2">
            <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
            <SecondaryButton disabled={busy} onClick={() => setEditing(false)}>
              انصراف
            </SecondaryButton>
          </div>
        </form>
      ) : (
        <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">
            {group.name}{" "}
            <span className="text-xs text-muted-foreground">
              (انتخاب {toPersianDigits(group.min_select)} تا{" "}
              {toPersianDigits(group.max_select)})
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <SecondaryButton
              disabled={busy}
              onClick={() => {
                setEditName(group.name);
                setEditMin(String(group.min_select));
                setEditMax(String(group.max_select));
                setEditing(true);
              }}
            >
              ویرایش
            </SecondaryButton>
            <SecondaryButton disabled={busy} onClick={removeGroup}>
              حذف
            </SecondaryButton>
          </div>
        </div>
      )}
      <ul className="mb-2 divide-y divide-border">
        {modifiers.map((m) => (
          <ModifierRow
            key={m.id}
            modifier={m}
            groups={groups}
            busy={busy}
            run={run}
          />
        ))}
        {modifiers.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">
            افزودنی‌ای ثبت نشده است.
          </p>
        ) : null}
      </ul>
      <form
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          void addModifier();
        }}
      >
        <Field label="نام افزودنی">
          <input
            className={inputClass}
            value={modifierName}
            onChange={(e) => setModifierName(e.target.value)}
          />
        </Field>
        <Field label={`مبلغ اضافه (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={modifierDelta}
            onChange={(e) => setModifierDelta(e.target.value)}
          />
        </Field>
        <div className="mb-4 flex items-end">
          <SecondaryButton onClick={addModifier} disabled={busy}>
            افزودن
          </SecondaryButton>
        </div>
      </form>
    </div>
  );
}

function ModifierRow({
  modifier,
  groups,
  busy,
  run,
}: {
  modifier: Modifier;
  groups: ModifierGroup[];
  busy: boolean;
  run: Runner;
}) {
  const money = useMoney();
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditModifierRow
        modifier={modifier}
        groups={groups}
        busy={busy}
        run={run}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <li className="flex min-w-0 flex-col gap-2 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
      <span
        className={`min-w-0 break-words ${modifier.is_active ? "" : "text-muted-foreground line-through"}`}
      >
        {modifier.name}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground">
          {money.format(Number(modifier.price_delta))}
        </span>
        <SecondaryButton disabled={busy} onClick={() => setEditing(true)}>
          ویرایش
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() =>
            run(() =>
              api(`/api/menu/modifiers/${modifier.id}`, {
                method: "PATCH",
                body: JSON.stringify({ isActive: !modifier.is_active }),
              }),
            )
          }
        >
          {modifier.is_active ? "غیرفعال" : "فعال"}
        </SecondaryButton>
        <SecondaryButton
          disabled={busy}
          onClick={() => {
            if (
              !window.confirm(
                `افزودنی «${modifier.name}» حذف شود؟ افزودنی که در سفارش استفاده شده باشد غیرفعال می‌شود.`,
              )
            )
              return;
            void run(() =>
              api(`/api/menu/modifiers/${modifier.id}`, { method: "DELETE" }),
            );
          }}
        >
          حذف
        </SecondaryButton>
      </div>
    </li>
  );
}

function EditModifierRow({
  modifier,
  groups,
  busy,
  run,
  onDone,
}: {
  modifier: Modifier;
  groups: ModifierGroup[];
  busy: boolean;
  run: Runner;
  onDone: () => void;
}) {
  const money = useMoney();
  const [groupId, setGroupId] = useState(modifier.group_id);
  const [name, setName] = useState(modifier.name);
  const [delta, setDelta] = useState(
    String(money.toInput(Number(modifier.price_delta))),
  );
  const moved = groupId !== modifier.group_id;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    let deltaRial: number;
    try {
      deltaRial = money.parse(delta);
    } catch {
      return;
    }
    if (!name.trim() || !groupId) return;
    const ok = await run(() =>
      api(`/api/menu/modifiers/${modifier.id}`, {
        method: "PATCH",
        body: JSON.stringify({ groupId, name, priceDelta: deltaRial }),
      }),
    );
    if (ok) onDone();
  }

  return (
    <li className="py-2">
      <form
        onSubmit={save}
        className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        <Field label="گروه افزودنی">
          <SearchableSelect
            value={groupId}
            onChange={setGroupId}
            options={groups.map((group) => ({
              value: group.id,
              label: group.name,
            }))}
          />
        </Field>
        <Field label="نام افزودنی">
          <input
            className={inputClass}
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
        <Field label={`مبلغ اضافه (${money.unitLabel})`}>
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            required
          />
        </Field>
        <div className="flex items-end gap-2">
          <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
          <SecondaryButton onClick={onDone} disabled={busy}>
            انصراف
          </SecondaryButton>
        </div>
        {moved ? (
          <p className="text-xs text-muted-foreground sm:col-span-2 xl:col-span-3">
            این افزودنی به گروه دیگری منتقل می‌شود و از این پس روی آیتم‌های همان
            گروه نمایش داده می‌شود. سفارش‌های ثبت‌شده تغییری نمی‌کنند.
          </p>
        ) : null}
      </form>
    </li>
  );
}
