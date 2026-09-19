"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

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
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { PlusIcon, RefreshCwIcon, ChevronDownIcon, ArrowLeftRightIcon, ReceiptTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMoney } from "@/components/money/money-context";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
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
import { crmCustomerHref, crmDealOrderHref } from "./crm-routes";

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
  const searchParams = useSearchParams();
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<Deal | "new" | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  // A deal moving to «از دست رفته» waits here for its reason before the move
  // actually commits — see `requestStageChange`.
  const [pendingLostId, setPendingLostId] = useState<string | null>(null);

  const load = useCallback(() => {
    api<{ deals: Deal[] }>("/api/crm/deals").then(({ ok, data }) => {
      if (ok) setDeals(data.deals);
      else setError("بارگذاری قیف فروش ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  // `/crm/deals?deal=<id>` is how the customer timeline and other screens hand
  // a specific deal over (see `customer-timeline-service.ts`). Without this,
  // that link lands on the generic board and the deal it promised is nowhere
  // to be found — the same convention the directory's `?customer=` follows.
  useEffect(() => {
    const dealId = searchParams.get("deal");
    if (!dealId || !deals) return;
    const target = deals.find((deal) => deal.id === dealId);
    if (target) {
      setEditing(target);
      const url = new URL(window.location.href);
      url.searchParams.delete("deal");
      window.history.replaceState(null, "", url.toString());
    }
  }, [searchParams, deals]);

  const move = async (dealId: string, stage: DealStage, lostReason?: string) => {
    // Optimistic: the card follows the cursor, and a failure re-reads the
    // server's truth rather than leaving the board lying.
    setDeals((current) =>
      current?.map((deal) => (deal.id === dealId ? { ...deal, stage } : deal)) ?? current,
    );
    const { ok, data } = await api<{ error?: string }>(`/api/crm/deals/${dealId}`, {
      method: "PATCH",
      body: JSON.stringify({ stage, lostReason }),
    });
    if (!ok) setError(errorMessage(data.error));
    load();
  };

  /**
   * The one gate every stage change passes through, whether it came from a
   * drag or the fallback menu. Moving *into* «از دست رفته» asks why first — a
   * card that lands there with no reason is a loss report nobody can read
   * later, and the edit dialog already treats the reason as part of that
   * stage, not an afterthought.
   */
  const requestStageChange = (dealId: string, stage: DealStage) => {
    if (stage === "lost") {
      setPendingLostId(dealId);
      return;
    }
    void move(dealId, stage);
  };

  if (!deals) {
    return <SectionCardSkeleton rows={4} />;
  }

  const open = deals.filter((deal) => !DEAL_STAGE_META[deal.stage].terminal);
  const weighted = weightedPipelineValue(open);
  const rawValue = open.reduce((sum, deal) => sum + deal.valueRial, 0);
  const pendingLostDeal = pendingLostId ? deals.find((deal) => deal.id === pendingLostId) ?? null : null;

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">معامله و فروش</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">قیف فروش</h2>
          </div>
        }
        description="کارت‌ها را بین مرحله‌ها بکشید، یا از منوی «جابه‌جایی» روی هر کارت استفاده کنید. رسیدن به «برنده» هیچ سندی ثبت نمی‌کند."
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
                      if (dragging) requestStageChange(dragging, stage);
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
                        <div className="flex items-start justify-between gap-1">
                          <button
                            type="button"
                            onClick={() => setEditing(deal)}
                            className="block min-w-0 flex-1 text-right text-sm font-medium text-foreground hover:underline"
                          >
                            <span className="block truncate">{deal.title}</span>
                          </button>
                          {/* HTML5 drag-and-drop has no touch/keyboard path, so a
                              phone or a keyboard-only user needs a real way to
                              move a card — not just a mouse gesture. */}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="-mt-1 -me-1 shrink-0"
                                aria-label={`جابه‌جایی «${deal.title}»`}
                              >
                                <ChevronDownIcon aria-hidden="true" className="size-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start" className="min-w-44">
                              <DropdownMenuLabel className="flex items-center gap-1.5 text-xs">
                                <ArrowLeftRightIcon aria-hidden="true" className="size-3.5" />
                                انتقال به مرحله
                              </DropdownMenuLabel>
                              <DropdownMenuSeparator />
                              {DEAL_STAGES.filter((target) => target !== deal.stage).map((target) => (
                                <DropdownMenuItem
                                  key={target}
                                  onClick={() => requestStageChange(deal.id, target)}
                                  className={target === "lost" ? "text-destructive focus:text-destructive" : ""}
                                >
                                  {DEAL_STAGE_META[target].label}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <p className="mt-1 text-sm font-semibold text-foreground/80">
                          {money.format(deal.valueRial)}
                        </p>
                        {deal.customerId ? (
                          <Link
                            href={crmCustomerHref(deal.customerId)}
                            className="mt-1 block truncate text-xs text-muted-foreground hover:underline"
                          >
                            {deal.customerName}
                          </Link>
                        ) : null}
                        {deal.expectedCloseDate ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            موعد: {toPersianDigits(formatJalali(deal.expectedCloseDate))}
                          </p>
                        ) : null}
                        {deal.stage === "won" && deal.orderId ? (
                          <Link
                            href={crmDealOrderHref(deal.orderId)}
                            className="mt-1 flex items-center gap-1 text-xs text-teal-700 hover:underline dark:text-teal-300"
                          >
                            <ReceiptTextIcon aria-hidden="true" className="size-3.5" />
                            سفارش تسویه‌شده
                          </Link>
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

      {pendingLostDeal ? (
        <LostReasonDialog
          dealTitle={pendingLostDeal.title}
          onClose={() => setPendingLostId(null)}
          onConfirm={(reason) => {
            void move(pendingLostDeal.id, "lost", reason);
            setPendingLostId(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The one thing a card dropped (or menu-moved) onto «از دست رفته» needs before
 * it commits: why. The full edit dialog already carries this field for a
 * *typed* stage change; this is the same question for the kanban's own
 * gesture, so a drag cannot silently produce a loss report with no reason on
 * it.
 */
function LostReasonDialog({
  dealTitle,
  onClose,
  onConfirm,
}: {
  dealTitle: string;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>«{dealTitle}» از دست رفت؟</DialogTitle>
        </DialogHeader>
        <Field label="دلیل از دست رفتن (اختیاری)">
          <input
            autoFocus
            className={inputClass}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثلاً قیمت بالا بود"
          />
        </Field>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            انصراف
          </Button>
          <Button type="button" variant="destructive" onClick={() => onConfirm(reason.trim())}>
            انتقال به «از دست رفته»
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [source, setSource] = useState(deal?.source ?? "");
  const [lostReason, setLostReason] = useState(deal?.lostReason ?? "");
  const [customerId, setCustomerId] = useState<string | null>(deal?.customerId ?? null);
  const [customerQuery, setCustomerQuery] = useState(deal?.customerName ?? "");
  const [matches, setMatches] = useState<{ id: string; name: string }[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Same live-directory search the activity and ticket dialogs use — a deal
  // attached to a customer is what makes it show on that customer's 360° file
  // and lets the pipeline link back to them.
  useEffect(() => {
    if (customerQuery.trim().length < 2 || customerId) {
      setMatches([]);
      setMatchesLoading(false);
      return;
    }
    let cancelled = false;
    setMatchesLoading(true);
    const timer = setTimeout(() => {
      void api<{ customers: { id: string; name: string }[] }>(
        `/api/parties?q=${encodeURIComponent(customerQuery.trim())}`,
      )
        .then(({ ok, data }) => {
          if (!cancelled && ok) setMatches(data.customers.slice(0, 6));
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setMatchesLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customerQuery, customerId]);

  const save = async () => {
    if (!title.trim()) {
      setError(errorMessage("deal_title_required"));
      return;
    }
    const probabilityValue = probability.trim() === "" ? null : Number(toLatinDigits(probability));
    if (
      probabilityValue !== null &&
      (!Number.isFinite(probabilityValue) || probabilityValue < 0 || probabilityValue > 100)
    ) {
      setError(errorMessage("deal_probability_invalid"));
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/deals", {
      method: "POST",
      body: JSON.stringify({
        id: deal?.id,
        // `customerId` and `orderId` ride along even though this form cannot
        // set the second one itself: the API replaces a deal's row wholesale
        // on every save, so leaving a field out of the body is how it used to
        // get silently cleared — a customer link vanishing the moment someone
        // fixed a typo in the title.
        customerId,
        title: title.trim(),
        description: description.trim(),
        stage,
        valueRial: money.fromInput(Number(toLatinDigits(value).replace(/[^\d]/g, "")) || 0),
        probability: probabilityValue,
        expectedCloseDate: expected || null,
        ownerUser: owner.trim(),
        source: source.trim(),
        lostReason: stage === "lost" ? lostReason.trim() : null,
        orderId: deal?.orderId ?? null,
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
        <Field label="مشتری (اختیاری)">
          {customerId ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-foreground">{customerQuery}</span>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  setCustomerId(null);
                  setCustomerQuery("");
                }}
              >
                تغییر
              </Button>
            </div>
          ) : (
            <>
              <input
                className={inputClass}
                placeholder="جستجوی نام یا شماره…"
                value={customerQuery}
                onChange={(e) => setCustomerQuery(e.target.value)}
              />
              {matchesLoading ? (
                <LoadingSkeleton rows={1} compact className="mt-1" label="در حال جست‌وجوی مشتری" />
              ) : matches.length > 0 ? (
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {matches.map((match) => (
                    <li key={match.id}>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          setCustomerId(match.id);
                          setCustomerQuery(match.name);
                          setMatches([]);
                        }}
                      >
                        {match.name}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </Field>
        <Field label={`مبلغ (${money.unitLabel})`} hint="انتظار فروش؛ هیچ سند حسابداری از این مبلغ ساخته نمی‌شود.">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            allowNegative={false}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="۰"
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
        {stage === "won" && deal?.orderId ? (
          <p className="mb-4 -mt-2 text-xs text-muted-foreground">
            این معامله به{" "}
            <Link href={crmDealOrderHref(deal.orderId)} className="text-teal-700 hover:underline dark:text-teal-300">
              سفارش تسویه‌شده
            </Link>{" "}
            وصل است.
          </p>
        ) : null}
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
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            allowNegative={false}
            grouping={false}
            value={probability}
            onChange={(e) => setProbability(e.target.value)}
            placeholder="۰"
          />
        </Field>
        <Field label="موعد پیش‌بینی‌شده (اختیاری)">
          <JalaliDatePicker value={expected} onChange={setExpected} placeholder="بدون موعد" />
        </Field>
        <Field label="مسئول پیگیری (اختیاری)">
          <input className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="منبع (اختیاری)" hint="این معامله از کجا شروع شد؛ مثلاً اینستاگرام، معرفی مشتری یا تماس تلفنی.">
          <input
            className={inputClass}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            placeholder="مثلاً اینستاگرام"
          />
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
