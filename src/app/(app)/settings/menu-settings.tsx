"use client";

import { useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { useMoney } from "@/components/money/money-context";
import { MenuManager } from "@/app/dashboard/menu/menu-manager";
import { ErrorBox, InfoBox, SecondaryButton, api, errorMessage } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";

interface ImportMatches {
  /** Existing same-name categories the file merges into. */
  categories: number;
  /** Of those, categories currently deactivated (import re-activates them). */
  inactiveCategories: number;
  /** Existing same-name items whose price/description/sku get overwritten. */
  items: number;
}

interface ImportPreview {
  items: number;
  categories: number;
  modifierGroups: number;
  modifiers: number;
  errors: string[];
  /** Advisory overlap with the current menu; null when the lookup failed. */
  matches?: ImportMatches | null;
}

interface ImportResponse {
  preview?: ImportPreview;
  error?: string;
  errors?: string[];
  createdCategories?: number;
  createdItems?: number;
  updatedItems?: number;
  createdGroups?: number;
  createdModifiers?: number;
  reactivatedCategories?: number;
}

/** Mirrors the route's MAX_FILE_BYTES, so oversized files are rejected before upload. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024)
    return `${toPersianDigits((bytes / (1024 * 1024)).toFixed(1)).replace(".", "٫")} مگابایت`;
  return `${toPersianDigits(Math.max(1, Math.round(bytes / 1024)))} کیلوبایت`;
}

/** Menu editor plus the operational CSV/Excel import flow. */
export function MenuSettings() {
  const money = useMoney();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  // Bumped after a successful import so <MenuManager> reloads and the list
  // below actually shows what was just imported — it fetches once on mount
  // otherwise, and the imported rows stayed invisible until a full reload.
  const [menuRevision, setMenuRevision] = useState(0);

  function pick(next: File | null) {
    setFile(next);
    setPreview(null);
    setSuccess("");
    setError("");
  }

  async function send(mode: "preview" | "apply") {
    if (!file) {
      setError("ابتدا فایل CSV یا Excel را انتخاب کنید.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("حجم فایل بیش از ۵ مگابایت است.");
      return;
    }
    setBusy(mode);
    setError("");
    setSuccess("");
    const form = new FormData();
    form.set("file", file);
    form.set("mode", mode);
    try {
      const { ok, data } = await api<ImportResponse>("/api/settings/menu/import", {
        method: "POST",
        body: form,
      });
      if (!ok) {
        setError(data.errors?.join(" ") || errorMessage(data.error));
        return;
      }
      if (data.preview) setPreview(data.preview);
      if (mode === "apply") {
        const summary = [
          `${toPersianDigits(data.createdItems ?? 0)} آیتم جدید`,
          data.updatedItems
            ? `${toPersianDigits(data.updatedItems)} آیتم به‌روزرسانی‌شده`
            : null,
          `${toPersianDigits(data.createdCategories ?? 0)} دستهٔ جدید`,
          data.createdGroups
            ? `${toPersianDigits(data.createdGroups)} گروه افزودنی`
            : null,
          data.reactivatedCategories
            ? `${toPersianDigits(data.reactivatedCategories)} دستهٔ غیرفعال فعال شد`
            : null,
        ]
          .filter(Boolean)
          .join("، ");
        setSuccess(`ورود منو انجام شد: ${summary}.`);
        setPreview(null);
        pick(null);
        if (input.current) input.current.value = "";
        setMenuRevision((revision) => revision + 1);
      }
    } catch {
      setError("ارتباط با سرور برقرار نشد. دوباره تلاش کنید.");
    } finally {
      setBusy(null);
    }
  }

  const applyBlocked = preview === null || preview.errors.length > 0;

  return (
    <div className="min-w-0 space-y-8">
      <SectionCard title="ورود گروهی منو">
        <p className="mb-4 text-sm text-muted-foreground">
          ابتدا پیش‌نمایش را ببینید، سپس ورود را تأیید کنید. فایل‌های CSV و XLSX پذیرفته
          می‌شوند و قیمت‌ها به {money.unitLabel} هستند.
        </p>
        <InfoBox>
          ستون‌های پشتیبانی‌شده: دسته، نام، قیمت، توضیحات، کد کالا، مالیات، گروه افزودنی،
          حداقل انتخاب، حداکثر انتخاب و افزودنی‌ها. برای افزودنی‌ها از الگوی «نام:مبلغ | نام:مبلغ»
          استفاده کنید؛ مبلغ به {money.unitLabel} است. اگر آیتمی با همین دسته و نام از قبل وجود
          داشته باشد، قیمت و توضیحات و کد آن به‌روزرسانی می‌شود.
        </InfoBox>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <input
            ref={input}
            className="block min-w-0 max-w-full text-sm file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-4 file:py-2 file:text-sm hover:file:bg-muted/70"
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null;
              if (next && next.size > MAX_FILE_BYTES) {
                pick(null);
                if (input.current) input.current.value = "";
                setError(`حجم «${next.name}» بیش از ۵ مگابایت است.`);
                return;
              }
              pick(next);
            }}
          />
          <a
            className="text-sm text-primary underline underline-offset-4"
            href="/api/settings/menu/template"
          >
            دانلود فایل نمونه
          </a>
          {file ? (
            <SecondaryButton onClick={() => pick(null)} disabled={busy !== null}>
              حذف انتخاب
            </SecondaryButton>
          ) : null}
        </div>
        {file ? (
          <p className="mt-3 min-w-0 break-words text-sm text-muted-foreground">
            فایل انتخاب‌شده: {file.name} ({formatBytes(file.size)})
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <SecondaryButton
            onClick={() => void send("preview")}
            disabled={busy !== null || !file}
          >
            {busy === "preview" ? "در حال بررسی…" : "پیش‌نمایش فایل"}
          </SecondaryButton>
          <SecondaryButton
            onClick={() => void send("apply")}
            disabled={busy !== null || applyBlocked}
          >
            {busy === "apply" ? "در حال ورود…" : "تأیید و ورود منو"}
          </SecondaryButton>
        </div>

        <ErrorBox>{error}</ErrorBox>
        {success ? <InfoBox>{success}</InfoBox> : null}
        {preview ? (
          <div className="mt-4 rounded-xl border border-border/80 p-4">
            <h3 className="mb-2 text-sm font-semibold">نتیجهٔ پیش‌نمایش</h3>
            <p className="text-sm text-muted-foreground">
              {toPersianDigits(preview.items)} آیتم در {toPersianDigits(preview.categories)}{" "}
              دسته، {toPersianDigits(preview.modifierGroups)} گروه افزودنی و{" "}
              {toPersianDigits(preview.modifiers)} افزودنی پیدا شد.
            </p>
            {preview.matches ? (
              <p className="mt-2 text-sm text-muted-foreground">
                {toPersianDigits(preview.matches.items)} آیتم هم‌نام از قبل موجود است و
                به‌روزرسانی می‌شود، {toPersianDigits(preview.items - preview.matches.items)}{" "}
                آیتم جدید افزوده می‌شود.
                {preview.matches.inactiveCategories > 0
                  ? ` ${toPersianDigits(
                      preview.matches.inactiveCategories,
                    )} دستهٔ غیرفعال دوباره فعال می‌شود.`
                  : ""}
              </p>
            ) : null}
            {preview.errors.length > 0 ? (
              <>
                <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-destructive">
                  {preview.errors.map((item, index) => (
                    <li key={`${item}-${index}`}>{item}</li>
                  ))}
                </ul>
                <p className="mt-2 text-sm text-muted-foreground">
                  برای ورود، ابتدا خطاهای فایل را اصلاح کنید.
                </p>
              </>
            ) : (
              <p className="mt-3 text-sm text-primary">فایل آمادهٔ ورود است.</p>
            )}
          </div>
        ) : null}
      </SectionCard>

      <section>
        <div className="mb-4">
          <h2 className="font-semibold">ویرایش منو</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            دسته‌ها، آیتم‌ها، قیمت‌ها و گروه‌های افزودنی را به‌صورت دستی مدیریت کنید.
          </p>
        </div>
        <MenuManager refreshToken={menuRevision} />
      </section>
    </div>
  );
}
