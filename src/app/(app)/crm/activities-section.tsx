"use client";

import { LoadingSkeleton, SectionCardSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Activities and tasks (Phase 36).
 *
 * One list for both, because they are one table: an activity with a future
 * `dueAt` and no `completedAt` *is* a task. `activityState` resolves which of
 * «انجام‌شده / امروز / عقب‌افتاده / برنامه‌ریزی‌شده» a row is, against the
 * business date rather than the browser's clock — a shop whose day starts at
 * 18:00 must not see tomorrow's work turn red at midnight.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import {
  ACTIVITY_KINDS,
  ACTIVITY_KIND_LABELS,
  ACTIVITY_STATE_LABELS,
  ACTIVITY_STATE_TONES,
  activityState,
  type ActivityKind,
} from "@/lib/crm-shared";
import { cardClass, EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass } from "@/app/dashboard/ui";
import { crmCustomerHref } from "./crm-routes";

interface Activity {
  id: string;
  customerId: string | null;
  customerName: string | null;
  dealId: string | null;
  caseId: string | null;
  kind: ActivityKind;
  subject: string;
  body: string;
  dueAt: string | null;
  completedAt: string | null;
  assignedTo: string;
  createdBy: string;
  createdAt: string;
}

export function ActivitiesSection() {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);

  // The business's own "today", so overdue means overdue for this shop. Taken
  // from the Shamsi helper the rest of the dashboard uses, converted back to
  // the ISO form `activityState` compares on.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const load = useCallback(() => {
    api<{ activities: Activity[] }>(`/api/crm/activities${openOnly ? "?open=1" : ""}`).then(
      ({ ok, data }) => {
        if (ok) setActivities(data.activities);
        else setError("بارگذاری کارها ناموفق بود.");
      },
    );
  }, [openOnly]);
  useEffect(load, [load]);

  const toggle = async (activity: Activity) => {
    const { ok, data } = await api<{ error?: string }>(`/api/crm/activities/${activity.id}`, {
      method: "PATCH",
      body: JSON.stringify({ completed: !activity.completedAt }),
    });
    if (!ok) setError(errorMessage(data.error));
    load();
  };

  const remove = async (activity: Activity) => {
    if (!window.confirm(`«${activity.subject}» حذف شود؟`)) return;
    const { ok } = await api(`/api/crm/activities/${activity.id}`, { method: "DELETE" });
    if (ok) load();
  };

  if (!activities) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  const overdue = activities.filter(
    (activity) => activityState(activity, today) === "overdue",
  ).length;

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پیگیری‌ها و وظایف</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">کارها و پیگیری‌ها</h2>
          </div>
        }
        description={
          overdue > 0
            ? `${toPersianDigits(String(overdue))} کار از موعدش گذشته است.`
            : "تماس‌ها، جلسه‌ها و یادآوری‌های مربوط به مشتریان."
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <Checkbox
                checked={openOnly}
                onCheckedChange={(checked) => setOpenOnly(checked === true)}
              />
              فقط انجام‌نشده‌ها
            </label>
            <Button type="button" variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setAdding(true)}>
              <PlusIcon aria-hidden="true" className="size-4" />
              کار جدید
            </Button>
          </div>
        }
      >
        {activities.length === 0 ? (
          <EmptyState>
            {openOnly
              ? "کار انجام‌نشده‌ای نمانده است."
              : "هنوز کاری ثبت نشده است. یک تماس پیگیری، یک یادآوری تولد، یا جلسه‌ای که باید گرفته شود."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border/80 text-sm">
            {activities.map((activity) => {
              const state = activityState(activity, today);
              return (
                <li key={activity.id} className="flex items-start gap-3 py-2.5">
                  <Checkbox
                    checked={Boolean(activity.completedAt)}
                    onCheckedChange={() => toggle(activity)}
                    aria-label={activity.completedAt ? "بازکردن دوباره" : "انجام شد"}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <p
                      className={`leading-6 ${
                        activity.completedAt ? "text-muted-foreground line-through" : "text-foreground"
                      }`}
                    >
                      {activity.subject}
                    </p>
                    {activity.body ? (
                      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{activity.body}</p>
                    ) : null}
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <StatusBadge tone={ACTIVITY_STATE_TONES[state]}>
                        {ACTIVITY_STATE_LABELS[state]}
                      </StatusBadge>
                      <StatusBadge tone="neutral">{ACTIVITY_KIND_LABELS[activity.kind]}</StatusBadge>
                      {activity.dueAt ? (
                        <span>موعد {toPersianDigits(formatJalali(activity.dueAt))}</span>
                      ) : null}
                      {activity.customerId ? (
                        <Link href={crmCustomerHref(activity.customerId)} className="hover:underline">
                          {activity.customerName}
                        </Link>
                      ) : null}
                      {activity.assignedTo ? <span>· {activity.assignedTo}</span> : null}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(activity)}
                    aria-label="حذف"
                    className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2Icon aria-hidden="true" className="size-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {activities.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">
            {formatPersianNumber(activities.length)} کار در این فهرست. امروز:{" "}
            {toPersianDigits(formatJalali(today))}
          </p>
        ) : null}
      </SectionCard>

      {adding ? (
        <ActivityDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function ActivityDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<ActivityKind>("call");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [matches, setMatches] = useState<{ id: string; name: string }[]>([]);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Attaching an activity to a customer is what makes it show on their file, so
  // the picker searches the live directory rather than asking for an id.
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
    if (!subject.trim()) {
      setError(errorMessage("activity_subject_required"));
      return;
    }
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string }>("/api/crm/activities", {
      method: "POST",
      body: JSON.stringify({
        kind,
        subject: subject.trim(),
        body: body.trim(),
        dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        assignedTo: assignedTo.trim(),
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

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>کار جدید</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="نوع">
          <select
            className={inputClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as ActivityKind)}
          >
            {ACTIVITY_KINDS.map((key) => (
              <option key={key} value={key}>
                {ACTIVITY_KIND_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="عنوان">
          <input className={inputClass} value={subject} onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="مشتری (اختیاری)" hint="با ثبت مشتری، این کار در پروندهٔ او هم دیده می‌شود.">
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
        <Field label="موعد (اختیاری)" hint="بدون موعد، این کار «برنامه‌ریزی‌شده» می‌ماند و هرگز عقب‌افتاده نمی‌شود.">
          <input
            type="datetime-local"
            className={inputClass}
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </Field>
        <Field label="مسئول (اختیاری)">
          <input
            className={inputClass}
            value={assignedTo}
            onChange={(e) => setAssignedTo(e.target.value)}
          />
        </Field>
        <Field label="توضیح (اختیاری)">
          <textarea
            className={inputClass}
            rows={2}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </Field>

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
