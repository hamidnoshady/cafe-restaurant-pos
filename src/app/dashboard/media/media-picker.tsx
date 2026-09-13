"use client";

/**
 * The shared image picker over «کتابخانهٔ رسانه» (migration 0149).
 *
 * One dialog every catalogue form opens: pick an image from the library or
 * upload a new one into it (the upload lands in the library too, so the file
 * is organized once and reused everywhere). Returns the chosen asset's id —
 * the caller stores it as `image_media_id` and renders the photo through
 * `/api/media/{id}/file`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cardClass, EmptyState, LoadingSkeleton } from "../page-chrome";
import { api, ErrorBox, inputClass } from "../ui";

export interface PickedMedia {
  id: string;
  fileName: string;
}

interface PickerAsset {
  id: string;
  fileName: string;
  mimeType: string;
  variant: "original" | "enhanced";
}

export function mediaFileUrl(id: string): string {
  return `/api/media/${id}/file`;
}

export function MediaPickerDialog({
  title,
  onPick,
  onClose,
}: {
  title: string;
  onPick: (asset: PickedMedia) => void;
  onClose: () => void;
}) {
  const [assets, setAssets] = useState<PickerAsset[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [storageReady, setStorageReady] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ kind: "image" });
    if (search) params.set("search", search);
    api<{ assets: PickerAsset[]; storage: { ready: boolean } }>(`/api/media?${params.toString()}`).then(
      ({ ok, data }) => {
        if (ok) {
          setAssets(data.assets.filter((a) => a.mimeType !== "image/svg+xml"));
          setStorageReady(data.storage.ready);
        } else setError("خواندن کتابخانهٔ رسانه ناموفق بود.");
      },
    );
  }, [search]);
  useEffect(load, [load]);

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError("");
    const form = new FormData();
    form.set("file", file);
    const res = await fetch("/api/media", { method: "POST", body: form });
    setBusy(false);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      setError(body.message ?? "بارگذاری ناموفق بود.");
      return;
    }
    const body = (await res.json()) as { asset: PickerAsset };
    onPick({ id: body.asset.id, fileName: body.asset.fileName });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-foreground/30 p-0 sm:items-center sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      <div className={`${cardClass} max-h-[90vh] w-full max-w-2xl overflow-y-auto p-4 sm:p-6`}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            بستن
          </Button>
        </div>

        {error ? <ErrorBox>{error}</ErrorBox> : null}

        <div className="mb-4 flex gap-2">
          <input
            className={inputClass}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="جست‌وجو در تصاویر کتابخانه…"
          />
          <Button
            variant="outline"
            disabled={busy || !storageReady}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? "در حال بارگذاری…" : "بارگذاری تصویر"}
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {!storageReady ? (
          <EmptyState>فضای ذخیره‌سازی رسانه هنوز توسط مدیر پلتفرم پیکربندی نشده است.</EmptyState>
        ) : assets === null ? (
          <LoadingSkeleton rows={4} />
        ) : assets.length === 0 ? (
          <EmptyState>تصویری در کتابخانه نیست؛ با «بارگذاری تصویر» اولین تصویر را اضافه کنید.</EmptyState>
        ) : (
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {assets.map((asset) => (
              <button
                key={asset.id}
                type="button"
                onClick={() => onPick({ id: asset.id, fileName: asset.fileName })}
                className="group overflow-hidden rounded-xl border border-border transition-colors hover:border-ring"
                title={asset.fileName}
              >
                <span className="block aspect-square overflow-hidden bg-muted">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={mediaFileUrl(asset.id)} alt={asset.fileName} loading="lazy" className="size-full object-cover" />
                </span>
                <span className="block truncate px-1.5 py-1 text-[11px] text-muted-foreground">{asset.fileName}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The compact form control: thumbnail + انتخاب/حذف. Give it the stored
 * `image_media_id` and it renders the photo and opens the picker.
 */
export function MediaImageField({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-4">
      <span className="mb-1 block text-sm font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-3">
        {value ? (
          <span className="block size-14 shrink-0 overflow-hidden rounded-lg border border-border bg-muted">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaFileUrl(value)} alt="" className="size-full object-cover" />
          </span>
        ) : (
          <span className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-lg text-muted-foreground" aria-hidden>
            🖼
          </span>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}>
            {value ? "تغییر تصویر" : "انتخاب از کتابخانه"}
          </Button>
          {value ? (
            <Button type="button" size="sm" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>
              حذف تصویر
            </Button>
          ) : null}
        </div>
      </div>
      {open ? (
        <MediaPickerDialog
          title={label}
          onClose={() => setOpen(false)}
          onPick={(asset) => {
            onChange(asset.id);
            setOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}
