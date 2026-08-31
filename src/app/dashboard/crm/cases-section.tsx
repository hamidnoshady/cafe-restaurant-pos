"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * The service desk (Phase 36) — complaints and requests.
 *
 * Floor-accessible, because the person who hears a complaint is the person at
 * the counter. A ticket queue only the office can write to is a queue that
 * never matches what customers actually said.
 *
 * `caseBreached` marks a ticket that has passed its priority's target. Note the
 * one asymmetry: a ticket in «منتظر مشتری» never breaches, because the clock
 * belongs to the customer then, and blaming the shop for the customer's silence
 * would make the whole indicator meaningless.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  CASE_PRIORITIES,
  CASE_PRIORITY_LABELS,
  CASE_PRIORITY_TARGET_HOURS,
  CASE_STATUSES,
  CASE_STATUS_LABELS,
  CASE_STATUS_TONES,
  caseBreached,
  type CasePriority,
  type CaseStatus,
} from "@/lib/crm-shared";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "../ui";
import { crmCustomerHref } from "./crm-routes";

interface ServiceCase {
  id: string;
  customerId: string | null;
  customerName: string | null;
  subject: string;
  body: string;
  status: CaseStatus;
  priority: CasePriority;
  category: string;
  orderId: string | null;
  assignedTo: string;
  resolution: string;
  openedAt: string;
  resolvedAt: string | null;
}

export function CasesSection() {
  const [cases, setCases] = useState<ServiceCase[] | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<ServiceCase | "new" | null>(null);

  const load = useCallback(() => {
    api<{ cases: ServiceCase[] }>(`/api/crm/cases${openOnly ? "?open=1" : ""}`).then(
      ({ ok, data }) => {
        if (ok) setCases(data.cases);
        else setError("بارگذاری تیکت‌ها ناموفق بود.");
      },
    );
  }, [openOnly]);
  useEffect(load, [load]);

  if (!cases) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const now = new Date();

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title="تیکت‌های خدمات"
        description="شکایت‌ها و درخواست‌های مشتریان، با زمان هدف رسیدگی بر پایهٔ اولویت."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-stone-600">
              <Checkbox
                checked={openOnly}
                onCheckedChange={(checked) => setOpenOnly(checked === true)}
              />
              فقط بازها
            </label>
            <Button type="button" variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              تیکت جدید
            </Button>
          </div>
        }
      >
        {cases.length === 0 ? (
          <EmptyState>
            {openOnly ? "تیکت بازی نمانده است." : "هنوز تیکتی ثبت نشده است."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-stone-200/80 text-sm">
            {cases.map((row) => {
              const breached = caseBreached(row, now);
              return (
                <li key={row.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setEditing(row)}
                      className="text-right font-medium text-stone-950 hover:underline"
                    >
                      {row.subject}
                    </button>
                    {row.body ? (
                      <p className="mt-0.5 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {row.body}
                      </p>
                    ) : null}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusBadge tone={CASE_STATUS_TONES[row.status]}>
                        {CASE_STATUS_LABELS[row.status]}
                      </StatusBadge>
                      <StatusBadge tone={row.priority === "urgent" ? "danger" : "neutral"}>
                        {CASE_PRIORITY_LABELS[row.priority]}
                      </StatusBadge>
                      {breached ? <StatusBadge tone="danger">از زمان هدف گذشته</StatusBadge> : null}
                      {row.customerId ? (
                        <Link href={crmCustomerHref(row.customerId)} className="hover:underline">
                          {row.customerName}
                        </Link>
                      ) : null}
                      <span>{toPersianDigits(formatJalali(row.openedAt))}</span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p className="mt-3 text-xs leading-6 text-muted-foreground">
          زمان هدف رسیدگی: فوری {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.urgent))} ساعت،
          زیاد {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.high))} ساعت، عادی{" "}
          {toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS.normal))} ساعت. تیکتی که «منتظر مشتری»
          است از زمان هدف نمی‌گذرد.
        </p>
      </SectionCard>

      {editing ? (
        <CaseDialog
          record={editing === "new" ? null : editing}
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

function CaseDialog({
  record,
  onClose,
  onSaved,
}: {
  record: ServiceCase | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState(record?.subject ?? "");
  const [body, setBody] = useState(record?.body ?? "");
  const [status, setStatus] = useState<CaseStatus>(record?.status ?? "open");
  const [priority, setPriority] = useState<CasePriority>(record?.priority ?? "normal");
  const [category, setCategory] = useState(record?.category ?? "");
  const [assignedTo, setAssignedTo] = useState(record?.assignedTo ?? "");
  const [resolution, setResolution] = useState(record?.resolution ?? "");
  const [customerQuery, setCustomerQuery] = useState(record?.customerName ?? "");
  const [customerId, setCustomerId] = useState<string | null>(record?.customerId ?? null);
  const [matches, setMatches] = useState<{ id: string; name: string }[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

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
        `/api/customers?q=${encodeURIComponent(customerQuery.trim())}`,
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
    if (!subject.trim()) {
      setError(errorMessage("case_subject_required"));
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/cases", {
      method: "POST",
      body: JSON.stringify({
        id: record?.id,
        subject: subject.trim(),
        body: body.trim(),
        status,
        priority,
        category: category.trim(),
        assignedTo: assignedTo.trim(),
        resolution: resolution.trim(),
        customerId,
      }),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  const resolved = status === "resolved" || status === "closed";

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{record ? `تیکت: ${record.subject}` : "تیکت جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="موضوع">
          <input className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="شرح">
          <textarea
            className={inputClass}
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>
        <Field label="مشتری (اختیاری)">
          {customerId ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-stone-950">{customerQuery}</span>
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
        <Field label="وضعیت">
          <select
            className={inputClass}
            value={status}
            onChange={(e) => setStatus(e.target.value as CaseStatus)}
          >
            {CASE_STATUSES.map((key) => (
              <option key={key} value={key}>
                {CASE_STATUS_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="اولویت"
          hint={`زمان هدف رسیدگی: ${toPersianDigits(String(CASE_PRIORITY_TARGET_HOURS[priority]))} ساعت.`}
        >
          <select
            className={inputClass}
            value={priority}
            onChange={(e) => setPriority(e.target.value as CasePriority)}
          >
            {CASE_PRIORITIES.map((key) => (
              <option key={key} value={key}>
                {CASE_PRIORITY_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="دسته (اختیاری)">
          <input className={inputClass} value={category} onChange={(e) => setCategory(e.target.value)} />
        </Field>
        <Field label="مسئول رسیدگی (اختیاری)">
          <input
            className={inputClass}
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          />
        </Field>
        {resolved ? (
          <Field label="شرح رسیدگی" hint="چه کاری برای مشتری انجام شد.">
            <textarea
              className={inputClass}
              rows={2}
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
            />
          </Field>
        ) : null}

        <DialogFooter>
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
