"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial } from "@/lib/money";
import {
  api,
  ErrorBox,
  errorMessage,
  Field,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";

interface Category {
  id: string;
  name: string;
}
interface Item {
  id: string;
  category_id: string | null;
  name: string;
  price: string | number;
}

export default function MenuStep() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // manual entry state
  const [newCategory, setNewCategory] = useState("");
  const [itemCategory, setItemCategory] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");

  // import state
  const fileRef = useRef<HTMLInputElement>(null);
  const [importSummary, setImportSummary] = useState("");
  const [importErrors, setImportErrors] = useState<string[]>([]);

  const load = useCallback(() => {
    api<{ categories: Category[]; items: Item[] }>("/api/setup/menu").then(({ data }) => {
      if (data.categories) setCategories(data.categories);
      if (data.items) setItems(data.items);
    });
  }, []);
  useEffect(load, [load]);

  async function addCategory() {
    if (!newCategory.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/setup/menu", {
      method: "POST",
      body: JSON.stringify({ addCategory: { name: newCategory } }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));
    setNewCategory("");
    load();
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    let price: number;
    try {
      price = parseToRial(itemPrice, "toman");
    } catch {
      setBusy(false);
      return setError("قیمت معتبر نیست.");
    }
    const { ok, data } = await api<{ error?: string }>("/api/setup/menu", {
      method: "POST",
      body: JSON.stringify({ addItem: { categoryId: itemCategory, name: itemName, price } }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));
    setItemName("");
    setItemPrice("");
    load();
  }

  async function importFile(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return setError("فایلی انتخاب نشده است.");
    setBusy(true);
    setError("");
    setImportSummary("");
    setImportErrors([]);
    const form = new FormData();
    form.append("file", file);
    const { ok, data } = await api<{
      error?: string;
      messages?: string[];
      createdCategories?: number;
      createdItems?: number;
      updatedItems?: number;
      errors?: string[];
    }>("/api/setup/menu/import", { method: "POST", body: form });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error, data.messages));
      return;
    }
    setImportSummary(
      `${toPersianDigits(data.createdCategories ?? 0)} دسته و ${toPersianDigits(
        data.createdItems ?? 0,
      )} آیتم ساخته شد` +
        (data.updatedItems ? `، ${toPersianDigits(data.updatedItems)} آیتم به‌روزرسانی شد` : "") +
        ".",
    );
    setImportErrors(data.errors ?? []);
    if (fileRef.current) fileRef.current.value = "";
    load();
  }

  return (
    <StepShell
      step="menu"
      description="منو را دستی وارد کنید یا از فایل CSV / Excel بیاورید. قیمت‌ها به تومان وارد می‌شوند."
      showNext
    >
      <ErrorBox>{error}</ErrorBox>

      <section className="mb-8 rounded-xl border border-stone-200 p-4">
        <h2 className="mb-3 font-semibold">ورود از فایل (CSV یا Excel)</h2>
        <p className="mb-3 text-sm text-stone-500">
          ستون‌های لازم: «دسته»، «نام»، «قیمت» (تومان) — ستون‌های «توضیحات» و «کد» اختیاری‌اند.{" "}
          <a className="text-amber-700 underline underline-offset-4" href="/api/setup/menu/template">
            دانلود فایل نمونه
          </a>
        </p>
        <form onSubmit={importFile} className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx"
            className="text-sm file:me-3 file:rounded-lg file:border-0 file:bg-stone-100 file:px-4 file:py-2 file:text-sm"
          />
          <PrimaryButton disabled={busy}>ورود فایل</PrimaryButton>
        </form>
        {importSummary ? <InfoBox>{importSummary}</InfoBox> : null}
        {importErrors.length > 0 ? (
          <div className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            {importErrors.map((e, i) => (
              <p key={i}>{e}</p>
            ))}
          </div>
        ) : null}
      </section>

      <section className="mb-8 grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-stone-200 p-4">
          <h2 className="mb-3 font-semibold">افزودن دسته</h2>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              placeholder="مثلاً نوشیدنی گرم"
            />
            <SecondaryButton onClick={addCategory} disabled={busy}>
              افزودن
            </SecondaryButton>
          </div>
        </div>

        <form onSubmit={addItem} className="rounded-xl border border-stone-200 p-4">
          <h2 className="mb-3 font-semibold">افزودن آیتم</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <select
              className={inputClass}
              value={itemCategory}
              onChange={(e) => setItemCategory(e.target.value)}
              required
            >
              <option value="">دسته…</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              className={inputClass}
              value={itemName}
              onChange={(e) => setItemName(e.target.value)}
              placeholder="نام آیتم"
              required
            />
            <input
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              value={itemPrice}
              onChange={(e) => setItemPrice(e.target.value)}
              placeholder="قیمت (تومان)"
              required
            />
          </div>
          <div className="mt-3">
            <PrimaryButton disabled={busy || categories.length === 0}>افزودن آیتم</PrimaryButton>
          </div>
        </form>
      </section>

      <section>
        <h2 className="mb-3 font-semibold">
          منوی فعلی — {toPersianDigits(categories.length)} دسته، {toPersianDigits(items.length)} آیتم
        </h2>
        {categories.length === 0 ? (
          <p className="text-sm text-stone-400">هنوز چیزی ثبت نشده است.</p>
        ) : (
          <div className="space-y-4">
            {categories.map((c) => (
              <div key={c.id}>
                <p className="mb-1 text-sm font-medium text-stone-700">{c.name}</p>
                <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200">
                  {items
                    .filter((i) => i.category_id === c.id)
                    .map((i) => (
                      <li key={i.id} className="flex justify-between px-4 py-2 text-sm">
                        <span>{i.name}</span>
                        <span className="text-stone-500">{formatToman(Number(i.price))}</span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>
    </StepShell>
  );
}
