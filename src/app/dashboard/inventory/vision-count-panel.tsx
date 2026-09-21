"use client";

/**
 * The «شمارش با دوربین و تصویر» panel inside انبارگردانی — the bridge
 * between the visual-count dialog and the stock-count tally.
 *
 * Its three jobs:
 *
 *   1. Pick the item (searchable, like every other picker in the workspace)
 *      and show that item's «برچسب‌های تصویری» — thumbnail chips with their
 *      kind (رنگ/دایره) and source (دستی/هوشمند), deletable in place.
 *   2. Open `VisionCountDialog` for that item, and route confirmed numbers
 *      into the same tally the barcode scanner feeds: adds by default,
 *      replace on request. The tally update is local and instant; the
 *      evidence POST runs right after and a failure only costs the audit
 *      row, never the count the operator just confirmed.
 *   3. Show the recent evidence rows («شواهد شمارش تصویری») — what was
 *      counted, how, with what confidence, and the photo it came from — so
 *      a number that surprises someone later can be *looked at*.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CameraIcon, CircleDotIcon, PaletteIcon, SparklesIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, Field } from "@/app/dashboard/ui";
import { formatQuantity, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import type { CountScanRecord, VisualProfileRecord } from "@/lib/inventory-visual-profiles";
import { VisionCountDialog, type VisionApplyPayload } from "./vision-count-dialog";
import type { InventoryItem, Runner } from "./inventory-manager";

const METHOD_LABELS: Record<CountScanRecord["method"], string> = {
  cv_color: "رنگ",
  cv_round: "دایره",
  ai_vision: "هوش مصنوعی",
};

export function VisionCountPanel({
  items,
  run,
  onApply,
}: {
  items: InventoryItem[];
  run: Runner;
  /** Applies a confirmed number to the stock-count tally (add or replace). */
  onApply: (inventoryItemId: string, qty: string, mode: "add" | "replace") => void;
}) {
  const [selectedItemId, setSelectedItemId] = useState("");
  const [profiles, setProfiles] = useState<VisualProfileRecord[] | null>(null);
  const [scans, setScans] = useState<CountScanRecord[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [evidenceWarning, setEvidenceWarning] = useState("");
  const item = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  const loadScans = useCallback(() => {
    api<{ scans: CountScanRecord[] }>("/api/inventory/visual-count-scans")
      .then(({ ok, data }) => {
        if (ok) setScans(data.scans);
        else setScans([]);
      })
      .catch(() => setScans([]));
  }, []);
  useEffect(loadScans, [loadScans]);

  // Profiles are per item; a cleared picker clears the list.
  useEffect(() => {
    if (!selectedItemId) {
      setProfiles(null);
      return;
    }
    let cancelled = false;
    setProfiles(null);
    api<{ profiles: VisualProfileRecord[] }>(
      `/api/inventory/visual-profiles?itemId=${encodeURIComponent(selectedItemId)}`,
    )
      .then(({ ok, data }) => {
        if (!cancelled && ok) setProfiles(data.profiles);
        else if (!cancelled) setProfiles([]);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedItemId]);

  const options = useMemo(
    () =>
      items.map((i) => ({
        value: i.id,
        label: `${i.name} (${i.unit})`,
        searchString: `${i.name} ${i.sku ?? ""} ${i.unit}`,
      })),
    [items],
  );

  const reloadProfiles = useCallback(() => {
    if (!selectedItemId) return;
    api<{ profiles: VisualProfileRecord[] }>(
      `/api/inventory/visual-profiles?itemId=${encodeURIComponent(selectedItemId)}`,
    )
      .then(({ ok, data }) => {
        if (ok) setProfiles(data.profiles);
      })
      .catch(() => setProfiles([]));
  }, [selectedItemId]);

  async function deleteProfile(id: string) {
    const ok = await run(() => api(`/api/inventory/visual-profiles/${id}`, { method: "DELETE" }));
    if (ok) reloadProfiles();
  }

  /** The dialog's confirmed payload: tally first (local), evidence after. */
  function handleApply(payload: VisionApplyPayload) {
    setEvidenceWarning("");
    onApply(payload.inventoryItemId, payload.countedQty, payload.mode);
    void api("/api/inventory/visual-count-scans", {
      method: "POST",
      body: JSON.stringify(payload),
    })
      .then(({ ok }) => {
        if (ok) {
          loadScans();
        } else {
          setEvidenceWarning("شمارش ثبت شد اما ذخیرهٔ تصویر شواهد ناموفق بود.");
        }
      })
      .catch(() => setEvidenceWarning("شمارش ثبت شد اما ذخیرهٔ تصویر شواهد ناموفق بود."));
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ابزار شمارش</p>
          <h2 className="mt-1 font-semibold text-foreground">شمارش با دوربین و تصویر</h2>
        </div>
      }
      description="قلم را انتخاب کنید و با دوربین گوشی، عکس یا ویدیو از موجودی آن شمارش خودکار بگیرید؛ نتیجه فقط پس از تأیید شما به فهرست شمارش اضافه می‌شود."
    >
      <div className="space-y-3">
        <Field label="قلم مورد شمارش">
          <SearchableSelect
            value={selectedItemId}
            onChange={setSelectedItemId}
            options={options}
            placeholder="نام قلم را جستجو کنید…"
            ariaLabel="انتخاب قلم برای شمارش تصویری"
          />
        </Field>

        {item ? (
          <div className="space-y-2">
            {profiles === null ? (
              <LoadingSkeleton rows={1} label="در حال خواندن برچسب‌های تصویری" />
            ) : (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                  برچسب‌های تصویری ({toPersianDigits(profiles.length)})
                </p>
                {profiles.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border px-3 py-3 text-xs leading-5 text-muted-foreground">
                    برچسبی ثبت نشده؛ در اولین شمارش، یک نمونه از قلم را برچسب بزنید (دستی یا با
                    هوش مصنوعی) تا شمارش‌های بعدی خودکار شود.
                  </p>
                ) : (
                  <ul className="flex flex-wrap gap-2">
                    {profiles.map((p) => (
                      <li
                        key={p.id}
                        className="group relative overflow-hidden rounded-xl border border-border bg-card"
                      >
                        { }
                        <img
                          src={p.imageDataUrl}
                          alt={`برچسب تصویری ${item.name}`}
                          className="size-16 object-cover"
                        />
                        <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-black/60 px-1 py-0.5 text-[10px] font-medium text-white">
                          {p.kind === "round" ? (
                            <CircleDotIcon className="size-3" aria-hidden="true" />
                          ) : (
                            <PaletteIcon className="size-3" aria-hidden="true" />
                          )}
                          {p.kind === "round" ? "دایره" : "رنگ"}
                          {p.source === "ai" ? <SparklesIcon className="size-3" aria-hidden="true" /> : null}
                        </span>
                        <button
                          type="button"
                          className="absolute top-1 end-1 rounded-lg bg-black/60 p-0.5 text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                          onClick={() => void deleteProfile(p.id)}
                          aria-label={`حذف برچسب تصویری ${item.name}`}
                        >
                          <XIcon className="size-3" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <Button
              type="button"
              size="lg"
              className="w-full font-semibold"
              onClick={() => setDialogOpen(true)}
              disabled={profiles === null}
            >
              <CameraIcon className="size-4" aria-hidden="true" />
              {profiles === null ? "در حال آماده‌سازی…" : "شروع شمارش تصویری"}
            </Button>
          </div>
        ) : null}

        {evidenceWarning ? (
          <p className="rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-3 py-2 text-xs text-amber-950 dark:text-amber-200" role="status">
            {evidenceWarning}
          </p>
        ) : null}

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">شواهد شمارش تصویری اخیر</p>
          {scans === null ? (
            <LoadingSkeleton rows={2} label="در حال خواندن شواهد شمارش" />
          ) : scans.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border px-3 py-3 text-xs leading-5 text-muted-foreground">
              هنوز شمارش تصویری ثبت نشده است.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {scans.slice(0, 6).map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  { }
                  <img
                    src={s.imageDataUrl}
                    alt={`تصویر شمارش ${s.itemName}`}
                    className="size-11 shrink-0 rounded-lg border border-border object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {s.itemName} — {formatQuantity(s.countedQty)} {s.unit}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {METHOD_LABELS[s.method]} · {formatJalali(s.createdAt)}
                      {s.createdByName ? ` — ${s.createdByName}` : ""}
                    </p>
                  </div>
                  <StatusBadge
                    tone={Number(s.confidence) >= 0.75 ? "positive" : Number(s.confidence) >= 0.45 ? "active" : "danger"}
                  >
                    {toPersianDigits(Math.round(Number(s.confidence) * 100))}٪
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {item ? (
        <VisionCountDialog
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          item={item}
          profiles={profiles ?? []}
          onProfileSaved={reloadProfiles}
          onProfileDeleted={reloadProfiles}
          onApply={handleApply}
        />
      ) : null}
    </SectionCard>
  );
}
