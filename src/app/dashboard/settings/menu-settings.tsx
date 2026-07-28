"use client";

import { useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { MenuManager } from "../menu/menu-manager";
import { ErrorBox, InfoBox, SecondaryButton, api, errorMessage } from "../ui";

interface ImportPreview {
  items: number;
  categories: number;
  modifierGroups: number;
  modifiers: number;
  errors: string[];
}

interface ImportResponse {
  preview?: ImportPreview;
  error?: string;
  errors?: string[];
}

/** Menu editor plus the operational CSV/Excel import flow. */
export function MenuSettings() {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function send(mode: "preview" | "apply") {
    if (!file) {
      setError("ابتدا فایل CSV یا Excel را انتخاب کنید.");
      return;
    }
    setBusy(mode);
    setError("");
    setSuccess("");
    const form = new FormData();
    form.set("file", file);
    form.set("mode", mode);
    const { ok, data } = await api<ImportResponse>("/api/settings/menu/import", { method: "POST", body: form });
    setBusy(null);
    if (!ok) {
      setError(data.errors?.join(" ") || errorMessage(data.error));
      return;
    }
    if (data.preview) setPreview(data.preview);
    if (mode === "apply") {
      setSuccess("ورود منو انجام شد. آیتم‌ها و افزودنی‌های جدید به منو افزوده شدند.");
      setPreview(null);
      setFile(null);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="min-w-0 space-y-8">
      <section className="min-w-0 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="mb-1 font-semibold">ورود گروهی منو</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          ابتدا پیش‌نمایش را ببینید، سپس ورود را تأیید کنید. فایل‌های CSV و XLSX پذیرفته می‌شوند و قیمت‌ها به تومان هستند.
        </p>
        <InfoBox>
          ستون‌های پشتیبانی‌شده: دسته، نام، قیمت، توضیحات، کد کالا، مالیات، گروه افزودنی، حداقل انتخاب، حداکثر انتخاب و افزودنی‌ها.
          برای افزودنی‌ها از الگوی «نام:مبلغ | نام:مبلغ» استفاده کنید؛ مبلغ به تومان است.
        </InfoBox>
        <div className="flex min-w-0 flex-wrap items-end gap-3">
          <label className="grid min-w-0 gap-1 text-sm font-medium">
            <span>فایل منو</span>
            <input
              ref={input}
              className="block max-w-full text-sm"
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setPreview(null);
                setSuccess("");
              }}
            />
          </label>
          <a className="text-sm text-primary underline underline-offset-4" href="/api/settings/menu/template">دانلود فایل نمونه</a>
        </div>
        {file ? <p className="mt-3 text-sm text-muted-foreground">فایل انتخاب‌شده: {file.name}</p> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          <SecondaryButton onClick={() => void send("preview")} disabled={busy !== null}>{busy === "preview" ? "در حال بررسی…" : "پیش‌نمایش فایل"}</SecondaryButton>
          {preview && preview.errors.length === 0 ? <SecondaryButton onClick={() => void send("apply")} disabled={busy !== null}>{busy === "apply" ? "در حال ورود…" : "تأیید و ورود منو"}</SecondaryButton> : null}
        </div>

        <ErrorBox>{error}</ErrorBox>
        {success ? <InfoBox>{success}</InfoBox> : null}
        {preview ? (
          <div className="mt-4 rounded-xl border border-border p-4">
            <h3 className="mb-2 text-sm font-semibold">نتیجهٔ پیش‌نمایش</h3>
            <p className="text-sm text-muted-foreground">
              {toPersianDigits(preview.items)} آیتم در {toPersianDigits(preview.categories)} دسته، {toPersianDigits(preview.modifierGroups)} گروه افزودنی و {toPersianDigits(preview.modifiers)} افزودنی پیدا شد.
            </p>
            {preview.errors.length > 0 ? (
              <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-destructive">
                {preview.errors.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
              </ul>
            ) : <p className="mt-3 text-sm text-primary">فایل آمادهٔ ورود است.</p>}
          </div>
        ) : null}
      </section>

      <section>
        <div className="mb-4">
          <h2 className="font-semibold">ویرایش منو</h2>
          <p className="mt-1 text-sm text-muted-foreground">دسته‌ها، آیتم‌ها، قیمت‌ها و گروه‌های افزودنی را به‌صورت دستی مدیریت کنید.</p>
        </div>
        <MenuManager />
      </section>
    </div>
  );
}
