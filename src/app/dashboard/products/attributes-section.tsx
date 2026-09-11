"use client";

/**
 * Phase 42 — «ویژگی محصول»: the attribute master as the reference seats it —
 * a card grid of defined attributes with an add-card, and an edit form with
 * the option list, an add-item row and the active switch. Data lives in
 * `item_attribute_definitions` (0140); existing variant rows keep their own
 * copies, so renaming here never rewrites sold stock.
 */
import { useCallback, useEffect, useState } from "react";
import { MoreVerticalIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { toPersianDigits } from "@/lib/digits";
import type { AttributeDefinition } from "@/lib/product-attributes-service";
import { api, ErrorBox, Field, inputClass } from "../ui";
import { cardClass, EmptyState, SectionCardSkeleton } from "../page-chrome";

type View = { mode: "list" } | { mode: "form"; definition: AttributeDefinition | null };

export function AttributesSection() {
  const [definitions, setDefinitions] = useState<AttributeDefinition[] | null>(null);
  const [view, setView] = useState<View>({ mode: "list" });
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ definitions: AttributeDefinition[] }>("/api/products/attributes").then(({ ok, data }) => {
      if (ok) setDefinitions(data.definitions);
    });
  }, []);
  useEffect(load, [load]);

  async function remove(definition: AttributeDefinition) {
    setError("");
    const { ok } = await api(`/api/products/attributes/${definition.id}`, { method: "DELETE" });
    if (!ok) setError("حذف نشد؛ دوباره تلاش کنید.");
    load();
  }

  if (view.mode === "form") {
    return (
      <AttributeForm
        definition={view.definition}
        onDone={(message) => {
          setView({ mode: "list" });
          load();
          void message;
        }}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {definitions === null ? (
        <SectionCardSkeleton rows={3} />
      ) : (
        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {definitions.map((definition, index) => (
            <section key={definition.id} className={`${cardClass} relative min-w-0 p-4`}>
              <div className="flex items-start justify-between gap-2">
                <span className="rounded-lg bg-amber-100 dark:bg-amber-500/20 px-2.5 py-1 text-xs font-semibold text-amber-950 dark:text-amber-200">
                  {toPersianDigits(index + 1)}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="sm" className="size-8 p-0" aria-label={`منوی ${definition.name}`}>
                      <MoreVerticalIcon aria-hidden="true" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => setView({ mode: "form", definition })}>
                      <PencilIcon aria-hidden="true" className="size-4" />
                      ویرایش
                    </DropdownMenuItem>
                    <DropdownMenuItem className="text-rose-600 dark:text-rose-400" onClick={() => remove(definition)}>
                      <Trash2Icon aria-hidden="true" className="size-4" />
                      حذف ویژگی
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <h3 className="mt-3 font-semibold text-foreground">{definition.name}</h3>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {definition.options.length > 0 ? definition.options.join("، ") : "بدون مقدار از پیش تعریف‌شده"}
              </p>
              {!definition.isActive ? (
                <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">غیرفعال</p>
              ) : null}
            </section>
          ))}
          <button
            type="button"
            onClick={() => setView({ mode: "form", definition: null })}
            className="flex min-h-40 min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border text-sm font-medium text-foreground/70 transition-colors hover:border-amber-300 dark:hover:border-amber-500/40 hover:bg-amber-50 dark:hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-300"
          >
            <PlusIcon aria-hidden="true" className="size-5" />
            افزودن ویژگی
          </button>
          {definitions.length === 0 ? (
            <div className="sm:col-span-2 xl:col-span-3">
              <EmptyState>هنوز ویژگی‌ای تعریف نشده؛ با «افزودن ویژگی» اولین ویژگی (مثلاً رنگ) را بسازید.</EmptyState>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function AttributeForm({
  definition,
  onDone,
  onBack,
}: {
  definition: AttributeDefinition | null;
  onDone: (message: string) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState(definition?.name ?? "");
  const [options, setOptions] = useState<string[]>(definition?.options ?? []);
  const [newOption, setNewOption] = useState("");
  const [isActive, setIsActive] = useState(definition?.isActive ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function addOption() {
    const value = newOption.trim();
    if (!value || options.includes(value)) return;
    setOptions((current) => [...current, value]);
    setNewOption("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) {
      setError("عنوان فارسی الزامی است.");
      return;
    }
    setBusy(true);
    setError("");
    const payload = { name: name.trim(), options, isActive };
    const { ok, data } = definition
      ? await api(`/api/products/attributes/${definition.id}`, { method: "PATCH", body: JSON.stringify(payload) })
      : await api("/api/products/attributes", { method: "POST", body: JSON.stringify(payload) });
    setBusy(false);
    if (!ok) {
      setError(data.error === "duplicate_name" ? "ویژگی‌ای با همین نام وجود دارد." : "ذخیره نشد؛ دوباره تلاش کنید.");
      return;
    }
    onDone("ذخیره شد.");
  }

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      <section className={`${cardClass} p-4 sm:p-5`}>
        <div className="flex items-center justify-between gap-2 border-b border-border/80 pb-3">
          <h2 className="font-semibold text-foreground">ویژگی</h2>
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            بازگشت
          </Button>
        </div>
        <form onSubmit={submit} className="mt-4 grid min-w-0 gap-4 lg:grid-cols-3">
          <Field label="عنوان فارسی">
            <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="رنگ" required />
          </Field>
          <div className="min-w-0">
            <span className="mb-1 block text-sm font-medium text-foreground">آیتم‌های ویژگی</span>
            <ul className="max-h-40 min-w-0 divide-y divide-border/80 overflow-y-auto rounded-lg border border-border/80">
              {options.map((option) => (
                <li key={option} className="flex items-center justify-between gap-2 px-3 py-2 text-sm text-foreground">
                  {option}
                  <button
                    type="button"
                    aria-label={`حذف ${option}`}
                    className="text-rose-600 dark:text-rose-400"
                    onClick={() => setOptions((current) => current.filter((o) => o !== option))}
                  >
                    <XIcon aria-hidden="true" className="size-4" />
                  </button>
                </li>
              ))}
              {options.length === 0 ? (
                <li className="px-3 py-2 text-xs text-muted-foreground">آیتمی ثبت نشده است.</li>
              ) : null}
            </ul>
          </div>
          <div className="min-w-0 space-y-4">
            <Field label="آیتم *">
              <input className={inputClass} value={newOption} onChange={(event) => setNewOption(event.target.value)} placeholder="عسلی" />
            </Field>
            <Button type="button" variant="outline" size="sm" className="w-full" onClick={addOption}>
              اضافه کردن آیتم
            </Button>
            <div className="flex items-center justify-between gap-2 rounded-xl bg-muted/60 px-3 py-2">
              <span className="text-sm text-foreground">وضعیت</span>
              <span className="flex items-center gap-2">
                <span className={`text-xs ${isActive ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground"}`}>
                  {isActive ? "فعال" : "غیرفعال"}
                </span>
                <Switch checked={isActive} onCheckedChange={setIsActive} aria-label="وضعیت ویژگی" />
              </span>
            </div>
          </div>
          <div className="lg:col-span-3">
            <Button type="submit" disabled={busy} size="lg" className="px-6 font-semibold">
              {definition ? "ویرایش ویژگی" : "ثبت ویژگی"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
