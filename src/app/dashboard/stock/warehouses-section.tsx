"use client";

/**
 * Phase 42b — the retail module's «انبارها» group: «افزودن انبار» and
 * «لیست انبارها».
 *
 * A warehouse is a branch: the list is the business's locations with what
 * each one holds on the RETAIL model — item count, stock value (Σ
 * item_stock.quantity × unit_cost, the same figure the stock-levels footer
 * totals), low-stock count (the classifyStockLevel rule) and the last stock
 * touch — and the form adds a new one through the same createBranch service
 * the branches screen uses.
 */
import { PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "../page-chrome";

export interface Warehouse {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  is_active: boolean;
  created_at: string;
  item_count: string;
  stock_value_rial: string;
  low_stock_count: string;
  last_movement_at: string | null;
}

interface WarehousesResponse {
  warehouses: Warehouse[];
}

const WAREHOUSE_ERRORS: Record<string, string> = {
  missing_fields: "نام انبار را وارد کنید.",
  // A warehouse *is* a branch (both screens write through branch-service's
  // createBranch), so these are the codes that service actually throws.
  // `location_name_taken` was the spelling this map guessed at; nothing has
  // ever thrown it, which is why a duplicate name used to fall through to
  // «خطای غیرمنتظره».
  branch_name_taken: "انباری با این نام وجود دارد.",
  location_name_taken: "انباری با این نام وجود دارد.",
  name_too_long: "نام انبار بیش از حد طولانی است.",
  address_too_long: "آدرس بیش از حد طولانی است.",
  phone_too_long: "شمارهٔ تلفن بیش از حد طولانی است.",
  branch_limit_exceeded: "به سقف تعداد انبار/شعبه در پلن فعلی رسیده‌اید.",
};

export function warehouseErrorMessage(code: string | undefined): string {
  if (!code) return "";
  return WAREHOUSE_ERRORS[code] ??
    (code === "unauthorized" ? "وارد نشده‌اید." : code === "forbidden" ? "دسترسی مجاز نیست." : code === "bad_request" ? "درخواست نامعتبر بود." : `خطای غیرمنتظره (${code}). دوباره تلاش کنید.`);
}

/** «افزودن انبار» — the form tab of the «انبارها» group. */
export function AddWarehouseSection({ onCreated }: { onCreated?: () => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    setDone("");
    const { ok, data } = await api("/api/stock/warehouses", {
      method: "POST",
      body: JSON.stringify({ name: name.trim(), address: address.trim() || undefined, phone: phone.trim() || undefined }),
    });
    setBusy(false);
    if (!ok) {
      setError(warehouseErrorMessage((data as { error?: string }).error));
      return;
    }
    setName("");
    setAddress("");
    setPhone("");
    setDone("انبار افزوده شد.");
    onCreated?.();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انبارها</p>
          <h2 className="mt-1 font-semibold text-foreground">افزودن انبار</h2>
        </div>
      }
      description="نام انبار را بنویسید؛ آدرس و تلفن اختیاری است. هر انبار یک شعبه است و اقلام و سندهای انبار به آن تعلق می‌گیرند."
    >
      <ErrorBox>{error}</ErrorBox>
      {done ? <p className="mb-3 text-xs text-emerald-700 dark:text-emerald-300">{done}</p> : null}
      <form onSubmit={submit} className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Field label="نام انبار">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً: انبار مرکزی" required />
        </Field>
        <Field label="آدرس (اختیاری)">
          <input className={inputClass} value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>
        <Field label="تلفن (اختیاری)">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="۰۲۱…"
          />
        </Field>
        <div className="flex items-end sm:col-span-2">
          <Button type="submit" disabled={busy || !name.trim()} size="lg" className="w-full px-5 font-semibold">
            <PlusIcon aria-hidden="true" className="size-4" />
            {busy ? "در حال افزودن…" : "افزودن انبار"}
          </Button>
        </div>
      </form>
    </SectionCard>
  );
}

/** «لیست انبارها» — the list tab of the «انبارها» group. */
export function WarehouseListSection({ onOpenStock }: { onOpenStock: (locationId: string) => void }) {
  const money = useMoney();
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<WarehousesResponse>("/api/stock/warehouses").then(({ ok, data }) => {
      if (ok) setWarehouses(data.warehouses);
      else setError(warehouseErrorMessage((data as { error?: string }).error));
    });
  }, []);
  useEffect(load, [load]);

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">انبارها</p>
          <h2 className="mt-1 font-semibold text-foreground">لیست انبارها</h2>
        </div>
      }
      description="هر انبار یک شعبه است؛ اقلام، موجودی و سندهای انبار به هر انبار تعلق دارند."
      flush
    >
      <ErrorBox>{error}</ErrorBox>
      {warehouses === null ? (
        <div className="p-4 sm:p-5">
          <LoadingSkeleton rows={4} label="در حال بارگذاری انبارها" />
        </div>
      ) : warehouses.length === 0 ? (
        <div className="p-4 sm:p-5">
          <EmptyState>هنوز انباری ثبت نشده است. از «افزودن انبار» اولین انبار را بسازید.</EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border bg-stone-50 dark:bg-stone-900/40">
                <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">انبار</th>
                <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">اقلام</th>
                <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">ارزش موجودی</th>
                <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">کمبود</th>
                <th className="px-4 py-3 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:px-5 sm:text-sm">آخرین تغییر موجودی</th>
                <th className="py-3 pe-4 text-start text-xs font-medium text-stone-500 dark:text-stone-400 sm:pe-5 sm:text-sm">وضعیت</th>
              </tr>
            </thead>
            <tbody>
              {warehouses.map((w) => (
                <tr
                  key={w.id}
                  className="border-b border-border/80 transition-colors last:border-b-0 hover:bg-stone-50/70 dark:hover:bg-stone-900/30"
                >
                  <td className="px-4 py-3 sm:px-5">
                    <button
                      type="button"
                      onClick={() => onOpenStock(w.id)}
                      className="text-start font-medium text-foreground outline-none focus-visible:ring focus-visible:ring-amber-400/40 dark:focus-visible:ring-amber-400/40"
                      title="مشاهده موجودی این انبار"
                    >
                      {w.name}
                    </button>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {[w.address, w.phone].filter(Boolean).join(" · ") || "—"}
                    </p>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{toPersianDigits(w.item_count)}</td>
                  <td className="px-4 py-3 font-medium tabular-nums">{money.format(Number(w.stock_value_rial))}</td>
                  <td className="px-4 py-3">
                    {Number(w.low_stock_count) > 0 ? (
                      <StatusBadge tone="active">{toPersianDigits(w.low_stock_count)} قلم</StatusBadge>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground tabular-nums">
                    {w.last_movement_at ? formatJalali(w.last_movement_at) : "—"}
                  </td>
                  <td className="py-3 pe-4 sm:pe-5">
                    {w.is_active ? <StatusBadge tone="positive">فعال</StatusBadge> : <StatusBadge tone="neutral">غیرفعال</StatusBadge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
