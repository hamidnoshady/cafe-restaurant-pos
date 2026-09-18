"use client";

import { SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The sales pipeline (Phase 36) — a kanban over `crm_deals`.
 *
 * The one thing to keep in mind reading this screen: **a deal is an
 * expectation, not a transaction.** Moving a card to «برنده» posts nothing;
 * revenue appears when an order or invoice is settled through the sales path
 * that already posts correctly. That is why the footer says so in Persian, why
 * a won deal links to its order rather than replacing one, and why the weighted
 * total is shown next to the raw one — the raw sum counts a first-contact lead
 * the same as a signed-tomorrow deal.
 */

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  DEAL_STAGES,
  DEAL_STAGE_META,
  weightedPipelineValue,
  winRate,
  type DealStage,
} from "@/lib/crm-shared";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";

interface Deal {
  id: string;
  customerId: string | null;
  customerName: string | null;
  title: string;
  description: string;
  stage: DealStage;
  valueRial: number;
  probability: number | null;
  expectedCloseDate: string | null;
  ownerUser: string;
  source: string;
  lostReason: string | null;
  orderId: string | null;
  closedAt: string | null;
  createdAt: string;
}

export function DealsSection() {
  const money = useMoney();
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Deal | "new" | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ deals: Deal[] }>("/api/crm/deals").then(({ ok, data }) => {
      if (ok) setDeals(data.deals);
      else setError("بارگذاری قیف فروش ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  const move = async (dealId: string, stage: DealStage) => {
    // Optimistic: the card follows the cursor, and a failure re-reads the
    // server's truth rather than leaving the board lying.
    setDeals((current) =>
      current?.map((deal) => (deal.id === dealId ? { ...deal, stage } : deal)) ?? current,
    );
    const { ok, data } = await api<{ error?: string }>(`/api/crm/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ stage }),
    });
    if (!ok) setError(errorMessage(data.error));
    load();
  };

  if (!deals) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const open = deals.filter((deal) => !DEAL_STAGE_META[deal.stage].terminal);
  const weighted = weightedPipelineValue(open);
  const rawValue = open.reduce((sum, deal) => sum + deal.valueRial, 0);

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">معامله و فروش</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">قیف فروش</h2>
          </div>
        }
        description="کارت‌ها را بین مرحله‌ها بکشید. رسیدن به «برنده» هیچ سندی ثبت نمی‌کند."
        actions={
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              معاملهٔ جدید
            </Button>
          </div>
        }
      >
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">ارزش خام معامله‌های باز</p>
            <p className="mt-1 font-semibold text-foreground">{money.format(rawValue)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">ارزش وزنی (بر پایهٔ احتمال)</p>
            <p className="mt-1 font-semibold text-teal-700 dark:text-teal-300">{money.format(weighted)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">نرخ موفقیت</p>
            <p className="mt-1 font-semibold text-foreground">
              {toPersianDigits(String(winRate(deals)))}٪
            </p>
          </div>
        </div>

        {deals.length === 0 ? (
          <EmptyState>هنوز معامله‌ای ثبت نشده است.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <div className="flex min-w-max gap-3">
              {DEAL_STAGES.map((stage) => {
                const meta = DEAL_STAGE_META[stage];
                const column = deals.filter((deal) => deal.stage === stage);
                const columnValue = column.reduce((sum, deal) => sum + deal.valueRial, 0);
                return (
                  <div
                    key={stage}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => {
                      if (dragging) move(dragging, stage);
                      setDragging(null);
                    }}
                    className="flex w-64 shrink-0 flex-col gap-2 rounded-2xl border border-border/80 bg-muted/60 p-3"
                  >
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-foreground">{meta.label}</span>
                        <StatusBadge tone={meta.tone}>
                          {formatPersianNumber(column.length)}
                        </StatusBadge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{money.format(columnValue)}</p>
                    </div>

                    {column.map((deal) => (
                      <article
                        key={deal.id}
                        draggable
                        onDragStart={() => setDragging(deal.id)}
                        onDragEnd={() => setDragging(null)}
                        className={`cursor-grab p-3 active:cursor-grabbing ${cardClass}`}
                      >
                        <button
                          type="button"
                          onClick={() => setEditing(deal)}
                          className="block w-full text-right text-sm font-medium text-foreground hover:underline"
                        >
                          {deal.title}
                        </button>
                        <p className="mt-1 text-sm font-semibold text-foreground/80">
                          {money.format(deal.valueRial)}
                        </p>
                        {deal.customerId ? (
                          <a
                            href={crmCustomerHref(deal.customerId)}
                            className="mt-1 block truncate text-xs text-muted-foreground hover:underline"
                          >
                            {deal.customerName}
                          </a>
                        ) : null}
                        {deal.expectedCloseDate ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            موعد: {toPersianDigits(formatJalali(deal.expectedCloseDate))}
                          </p>
                        ) : null}
                        {deal.stage === "lost" && deal.lostReason ? (
                          <p className="mt-1 text-xs text-rose-700 dark:text-rose-300">{deal.lostReason}</p>
                        ) : null}
                      </article>
                    ))}

                    {column.length === 0 ? (
                      <p className="py-4 text-center text-xs text-muted-foreground">خالی</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <p className="mt-4 text-xs leading-6 text-muted-foreground">
          مبلغ معامله یک انتظار است، نه یک سند. درآمد تنها زمانی ثبت می‌شود که فاکتور یا سفارش
          واقعی تسویه شود؛ بردن یک معامله در این صفحه هیچ اثری بر دفتر حساب‌ها ندارد.
        </p>
      </SectionCard>

      {editing ? (
        <DealDialog
          deal={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function DealDialog({
  deal,
  onClose,
  onSaved,
}: {
  deal: Deal | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const [title, setTitle] = useState(deal?.title ?? "");
  const [description, setDescription] = useState(deal?.description ?? "");
  const [stage, setStage] = useState<DealStage>(deal?.stage ?? "lead");
  const [value, setValue] = useState(String(money.toInput(deal?.valueRial ?? 0)));
  const [probability, setProbability] = useState(
    deal?.probability === null || deal?.probability === undefined ? "" : String(deal.probability),
  );
  const [expected, setExpected] = useState(deal?.expectedCloseDate?.slice(0, 10) ?? "");
  const [owner, setOwner] = useState(deal?.ownerUser ?? "");
  const [lostReason, setLostReason] = useState(deal?.lostReason ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!title.trim()) {
      setError(errorMessage("deal_title_required"));
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/deals", {
      method: "POST",
      body: JSON.stringify({
        id: deal?.id,
        title: title.trim(),
        description: description.trim(),
        stage,
        valueRial: money.fromInput(Number(toLatinDigits(value).replace(/[^\d]/g, "")) || 0),
        probability: probability.trim() === "" ? null : Number(toLatinDigits(probability)),
        expectedCloseDate: expected || null,
        ownerUser: owner.trim(),
        lostReason: stage === "lost" ? lostReason.trim() : null,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  const remove = async () => {
    if (!deal || !window.confirm(`«${deal.title}» حذف شود؟`)) return;
    const { ok } = await api(`/api/crm/deals/${deal.id}`, { method: "DELETE" });
    if (ok) onSaved();
  };

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{deal ? `ویرایش ${deal.title}` : "معاملهٔ جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="عنوان">
          <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label={`مبلغ (${money.unitLabel})`} hint="انتظار فروش؛ هیچ سند حسابداری از این مبلغ ساخته نمی‌شود.">
          <input
            className={inputClass}
            value={toPersianDigits(value)}
            onChange={(e) => setValue(toLatinDigits(e.target.value).replace(/[^\d]/g, ""))}
          />
        </Field>
        <Field label="مرحله">
          <select
            className={inputClass}
            value={stage}
            onChange={(e) => setStage(e.target.value as DealStage)}
          >
            {DEAL_STAGES.map((key) => (
              <option key={key} value={key}>
                {DEAL_STAGE_META[key].label}
              </option>
            ))}
          </select>
        </Field>
        {stage === "lost" ? (
          <Field label="دلیل از دست رفتن">
            <input
              className={inputClass}
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
            />
          </Field>
        ) : null}
        <Field
          label="احتمال موفقیت (٪)"
          hint={`خالی بگذارید تا احتمال پیش‌فرض این مرحله (${toPersianDigits(String(DEAL_STAGE_META[stage].probability))}٪) به کار برود.`}
        >
          <input
            className={inputClass}
            value={toPersianDigits(probability)}
            onChange={(e) => setProbability(toLatinDigits(e.target.value).replace(/[^\d]/g, ""))}
          />
        </Field>
        <Field label="موعد پیش‌بینی‌شده (اختیاری)">
          <JalaliDatePicker value={expected} onChange={setExpected} placeholder="بدون موعد" />
        </Field>
        <Field label="مسئول پیگیری (اختیاری)">
          <input className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="توضیح (اختیاری)">
          <textarea
            className={inputClass}
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <DialogFooter>
          {deal ? (
            <Button
              type="button"
              variant="ghost"
              onClick={remove}
              disabled={busy}
              className="me-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              حذف
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
