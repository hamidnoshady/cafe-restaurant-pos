"use client";

import { EmptyState, SectionCardSkeleton, StatusBadge } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { useMoney } from "@/components/money/money-context";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import type { Runner } from "./accounting-manager";
import { cardClass } from "@/app/dashboard/page-chrome";
import { roleLabel } from "@/lib/role-labels";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface StaffWage {
  id: string;
  fullName: string;
  role: string;
  monthlyWage: number | null;
}

interface PayrollRunLine {
  userId: string | null;
  fullName: string | null;
  amount: number;
}

type PayrollRunStatus = "accrued" | "paid" | "voided";

interface PayrollRun {
  id: string;
  periodLabel: string;
  status: PayrollRunStatus;
  totalAmount: number;
  accrualDate: string;
  paidDate: string | null;
  voidedDate: string | null;
  createdByName: string | null;
  lines: PayrollRunLine[];
}

// The team roles a staff member can hold, in the platform's own Persian —
// one definition (src/lib/role-labels.ts), so this section and the team
// screen can never disagree about what a role is called; an unknown role
// falls back to its raw key rather than a blank.

/**
 * The run statuses, as the shared `StatusBadge` tones rather than a private
 * palette. The badge is the primitive every other ledger surface uses for a
 * status pill (`installments`, `chart-of-accounts`), so payroll had no reason
 * to hand-roll amber/emerald classes of its own — and the hand-rolled copy is
 * what drifted from them.
 */
const STATUS_TONES: Record<PayrollRunStatus, { label: string; tone: "active" | "positive" | "neutral" }> = {
  paid: { label: "پرداخت‌شده", tone: "positive" },
  accrued: { label: "تعهدشده", tone: "active" },
  voided: { label: "ابطال‌شده", tone: "neutral" },
};

/** The longest «دوره» heading the API accepts (PERIOD_LABEL_MAX in payroll-service.ts). */
const PERIOD_LABEL_MAX = 120;

/**
 * A date the server sent, as Shamsi — or a dash when it is absent/unparseable.
 *
 * `formatJalali` throws a `RangeError` on an invalid date, and a throw inside
 * a client component's render takes the whole section down to an error
 * boundary. A payroll row whose date somehow arrived malformed should cost one
 * dash, not the screen.
 */
function jalaliOrDash(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return toPersianDigits(formatJalali(value));
  } catch {
    return "—";
  }
}

/**
 * Journal-level payroll — staff cost accrual and payment, not a payroll
 * engine (no tax tables, insurance, or payslips). Restricted to owner and
 * accountant: wages are compensation data, more sensitive than the rest of
 * this phase's ledger surfaces, which managers can otherwise post to freely.
 */
export function PayrollSection({ busy, run, refreshKey }: { busy: boolean; run: Runner; refreshKey: number }) {
  const money = useMoney();
  const [staff, setStaff] = useState<StaffWage[] | null>(null);
  const [runs, setRuns] = useState<PayrollRun[] | null>(null);
  const [wageInputs, setWageInputs] = useState<Record<string, string>>({});
  const [savingWage, setSavingWage] = useState<string | null>(null);
  /*
   * The rows the user has typed into since the last load.
   *
   * Distinct from "has a value in wageInputs": every row has one of those.
   * Only these are protected from being overwritten by a refresh. */
  const [editedRows, setEditedRows] = useState<Set<string>>(() => new Set());
  /*
   * ...and the same set as a ref, because `load` reads it.
   *
   * If `load` closed over the state it would have to list it as a dependency,
   * and then the first keystroke in any wage field would change the callback's
   * identity and re-fire the effect below — refetching the whole section
   * mid-typing. The ref keeps the reader stable; the state stays the thing
   * that renders.
   */
  const editedRowsRef = useRef(editedRows);
  useEffect(() => {
    editedRowsRef.current = editedRows;
  }, [editedRows]);
  const [periodLabel, setPeriodLabel] = useState("");
  const [accrualDate, setAccrualDate] = useState("");
  const [localError, setLocalError] = useState("");
  const [localNotice, setLocalNotice] = useState("");
  /*
   * «پرداخت از» — the account the payout leaves.
   *
   * `POST /api/ledger/payroll/runs/:id/pay` has accepted `cash` or `bank` since
   * this feature shipped, and the payment posts against whichever is chosen.
   * The button hardcoded `cash` and said «پرداخت (از صندوق)», so a business
   * paying wages by transfer had to either post it from the till or write the
   * entry by hand.
   */
  const [payMethod, setPayMethod] = useState<Record<string, "cash" | "bank">>({});
  /*
   * Which run a per-row action is in flight for.
   *
   * `busy` is the whole workspace's flag, so it disables *every* button on the
   * screen at once and says nothing about which one is working. A payment that
   * takes a second looked like the page had frozen; now the row that was
   * clicked says «در حال ثبت…» and only that row's buttons are locked.
   */
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  /** The run «ابطال» is asking about — a real dialog, not `window.confirm`. */
  const [voidTarget, setVoidTarget] = useState<PayrollRun | null>(null);
  const periodFieldId = useId();
  const accrualFieldId = useId();

  const load = useCallback(() => {
    api<{ staff: StaffWage[] }>("/api/ledger/payroll/staff").then(({ ok, data }) => {
      if (ok) {
        setStaff(data.staff);
        /*
         * Only the rows the user actually typed into keep their text; every
         * other row is re-derived from the server.
         *
         * Re-seeding *every* input from the response discarded whatever had
         * been typed into the other rows the moment one row was saved (or the
         * section refreshed) — on a ten-person list, nine edits lost in
         * silence. But keeping every input that merely *existed* is wrong in
         * the other direction: the displayed number depends on the money unit,
         * so after a ریال→تومان switch the untouched rows would still show
         * rial figures relabelled as toman — off by a factor of ten, in the
         * one field where that matters most. Tracking the edited ids
         * explicitly is what separates "the user's unsaved work" from "a
         * value we rendered", so each can be treated correctly.
         */
        setWageInputs((prev) => {
          const next: Record<string, string> = {};
          for (const s of data.staff) {
            const serverValue = s.monthlyWage != null ? String(money.toInput(s.monthlyWage)) : "";
            next[s.id] = editedRowsRef.current.has(s.id) ? (prev[s.id] ?? serverValue) : serverValue;
          }
          return next;
        });
        // Drop edit marks for staff who are no longer listed, so the set
        // cannot grow across refreshes.
        setEditedRows((prev) => {
          const live = new Set(data.staff.map((s) => s.id));
          const kept = [...prev].filter((id) => live.has(id));
          return kept.length === prev.size ? prev : new Set(kept);
        });
      } else {
        // An endless skeleton reads as "still loading"; name the failure.
        setStaff([]);
        setLocalError("بارگذاری فهرست کارکنان ناموفق بود.");
      }
    });
    api<{ runs: PayrollRun[] }>("/api/ledger/payroll/runs").then(({ ok, data }) => {
      if (ok) setRuns(data.runs);
      else {
        setRuns([]);
        setLocalError("بارگذاری تاریخچه حقوق ناموفق بود.");
      }
    });
  }, [money]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  // The staff who will actually be accrued: an active member with a positive
  // wage set. This mirrors accruePayroll's own WHERE clause, so the preview and
  // the total match exactly what a «ثبت تعهد» will post.
  const payableStaff = useMemo(() => (staff ?? []).filter((s) => s.monthlyWage != null && s.monthlyWage > 0), [staff]);
  const monthlyWageBill = useMemo(() => payableStaff.reduce((sum, s) => sum + (s.monthlyWage ?? 0), 0), [payableStaff]);

  /**
   * Has this row been edited away from what the server holds?
   *
   * Drives the per-row «ذخیره‌نشده» hint and keeps the save button meaningful:
   * saving a row nobody touched posts a no-op request and reports success for
   * a change that never happened.
   */
  const isWageDirty = useCallback(
    (s: StaffWage) => {
      const current = (wageInputs[s.id] ?? "").trim();
      const saved = s.monthlyWage != null ? String(money.toInput(s.monthlyWage)) : "";
      return current !== saved;
    },
    [money, wageInputs],
  );

  const dirtyCount = useMemo(() => (staff ?? []).filter(isWageDirty).length, [staff, isWageDirty]);

  /*
   * A success notice is about something that has finished, so it should not
   * outlive it. Without this the banner sat there until the next action —
   * «حقوق ذخیره شد.» still on screen minutes later, describing a save the user
   * had long since moved on from, and (worse) still there after a *failed*
   * action that only set the error line, showing success and failure at once.
   */
  useEffect(() => {
    if (!localNotice) return;
    const timer = window.setTimeout(() => setLocalNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [localNotice]);

  /*
   * Forget the «پرداخت از» choice for runs that are no longer listed.
   *
   * The map is keyed by run id and was only ever added to, so every run the
   * user ever touched stayed in memory for the life of the section. Pruning it
   * against the current list keeps it bounded, and means a run id reused after
   * a refresh cannot inherit a stale choice.
   */
  useEffect(() => {
    if (!runs) return;
    setPayMethod((prev) => {
      const live = new Set(runs.map((r) => r.id));
      const kept = Object.keys(prev).filter((id) => live.has(id));
      if (kept.length === Object.keys(prev).length) return prev;
      return Object.fromEntries(kept.map((id) => [id, prev[id]]));
    });
  }, [runs]);

  /*
   * Unsaved wages must survive leaving the page as a *warning*, not silently.
   * A wage typed and not saved is indistinguishable from a wage that was
   * saved, and the section is one rail click away from being unmounted.
   */
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  async function saveWage(userId: string) {
    setLocalError("");
    setLocalNotice("");
    const raw = wageInputs[userId] ?? "";
    let rial: number | null = null;
    if (raw.trim()) {
      try {
        rial = money.parse(raw);
      } catch {
        return setLocalError("مبلغ حقوق معتبر نیست.");
      }
      // The API stores Rial as a BIGINT and refuses a negative or fractional
      // amount; catching it here names the field instead of bouncing off a
      // generic server error.
      if (!Number.isSafeInteger(rial) || rial < 0) {
        return setLocalError("مبلغ حقوق معتبر نیست.");
      }
    }
    setSavingWage(userId);
    const { ok, data } = await api("/api/ledger/payroll/staff/" + userId, {
      method: "PATCH",
      body: JSON.stringify({ monthlyWage: rial }),
    });
    setSavingWage(null);
    if (!ok) return setLocalError(errorMessage((data as { error?: string }).error));
    const saved = staff?.find((s) => s.id === userId);
    setLocalNotice(saved ? `حقوق «${saved.fullName}» ذخیره شد.` : "حقوق ذخیره شد.");
    // Drop this row's local edit so the reload can adopt the server's value.
    setWageInputs((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
    setEditedRows((prev) => {
      if (!prev.has(userId)) return prev;
      const next = new Set(prev);
      next.delete(userId);
      return next;
    });
    load();
  }

  async function accrue(e: React.FormEvent) {
    e.preventDefault();
    setLocalError("");
    setLocalNotice("");
    const label = periodLabel.trim();
    if (!label) return setLocalError("عنوان دوره الزامی است.");
    if (label.length > PERIOD_LABEL_MAX) return setLocalError("عنوان دوره بیش از حد طولانی است.");
    if (payableStaff.length === 0) return setLocalError("هیچ کارمندی حقوق تعیین‌شده ندارد.");
    /*
     * An accrual is a journal entry, and posting the same month twice is the
     * mistake this screen makes easiest — the API has no uniqueness rule on a
     * period label, so «مرداد ۱۴۰۴» can be booked as many times as it is
     * clicked. Warn on an exact repeat of a run that still stands.
     */
    const clash = (runs ?? []).find((r) => r.status !== "voided" && r.periodLabel.trim() === label);
    if (clash && !window.confirm(`برای دوره «${label}» قبلاً تعهدی ثبت شده است. تعهد دیگری ثبت شود؟`)) return;

    const ok = await run(() =>
      api("/api/ledger/payroll/runs", {
        method: "POST",
        body: JSON.stringify({ periodLabel: label, accrualDate: accrualDate || undefined }),
      }),
    );
    if (ok) {
      setPeriodLabel("");
      setAccrualDate("");
      setLocalNotice(`تعهد حقوق دوره «${label}» ثبت شد.`);
    }
  }

  async function pay(runId: string) {
    const method = payMethod[runId] ?? "cash";
    setLocalError("");
    setLocalNotice("");
    setRowBusy(runId);
    const ok = await run(() =>
      api("/api/ledger/payroll/runs/" + runId + "/pay", { method: "POST", body: JSON.stringify({ method }) }),
    );
    setRowBusy(null);
    if (ok) setLocalNotice("پرداخت حقوق ثبت شد.");
  }

  async function confirmVoid() {
    const target = voidTarget;
    if (!target) return;
    setVoidTarget(null);
    setLocalError("");
    setLocalNotice("");
    setRowBusy(target.id);
    const ok = await run(() => api("/api/ledger/payroll/runs/" + target.id + "/void", { method: "POST" }));
    setRowBusy(null);
    if (ok) setLocalNotice(`تعهد دوره «${target.periodLabel}» ابطال شد.`);
  }

  if (!staff || !runs) {
    return (
      <SectionCardSkeleton rows={4} />
    );
  }

  return (
    <div className="space-y-5">
      {/*
        * Both banners are live regions that stay mounted, so a screen reader
        * announces a save or a failure. Rendering them only when there is a
        * message means the region is *created* with its text already in it,
        * which many readers never announce at all.
        */}
      <div aria-live="assertive" role="alert">
        {localError ? (
          <p className="rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {localError}
          </p>
        ) : null}
      </div>
      <div aria-live="polite" role="status">
        {localNotice ? (
          <p className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
            {localNotice}
          </p>
        ) : null}
      </div>

      <section aria-labelledby="payroll-wages-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">تنظیمات حقوق</p>
          <h2 id="payroll-wages-heading" className="mt-1 text-base font-semibold text-foreground">حقوق ماهانه کارکنان</h2>
          {/* The unit is the business's own choice (ریال/تومان), so it comes from
              the money context rather than being asserted in the copy. */}
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            مبلغ حقوق هر کارمند را به {money.unitLabel} وارد و ذخیره کنید.
          </p>
        </header>

        <div className="p-4 sm:p-5">
        {staff.length === 0 ? (
          <EmptyState>عضو فعالی یافت نشد.</EmptyState>
        ) : (
          <>
          <ul className="space-y-3">
            {staff.map((s) => {
              const dirty = isWageDirty(s);
              return (
              <li
                key={s.id}
                className="grid gap-3 rounded-xl border border-border/80 bg-muted/60 p-4 md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,15rem)_auto] md:items-end"
              >
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted-foreground">کارمند</p>
                  {/* A long Persian name has to wrap rather than push the grid
                      wider than the card on a narrow screen. */}
                  <p className="mt-1 break-words font-semibold text-foreground">{s.fullName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{roleLabel(s.role)}</p>
                </div>
                <label className="block text-sm font-medium">
                  <span className="mb-1.5 block text-xs text-muted-foreground">حقوق ماهانه ({money.unitLabel})</span>
                  <PersianNumberInput
                    className={inputClass + " w-full"}
                    dir="ltr"
                    inputMode="numeric"
                    // A wage is a whole amount: decimals and negatives are not
                    // wages, and the API refuses both — so don't let them be typed.
                    allowDecimal={false}
                    allowNegative={false}
                    value={wageInputs[s.id] ?? ""}
                    onChange={(e) => {
                      setWageInputs((prev) => ({ ...prev, [s.id]: e.target.value }));
                      setEditedRows((prev) => (prev.has(s.id) ? prev : new Set(prev).add(s.id)));
                    }}
                    // The placeholder repeated the label it sits under; «۰» is
                    // what every other money field in the ledger shows.
                    placeholder="۰"
                    aria-label={"حقوق ماهانه " + s.fullName}
                    // Enter saves the row the caret is in, the way a one-field
                    // form does — reaching for the mouse per row is the whole
                    // friction of this list.
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (!busy && savingWage !== s.id && dirty) void saveWage(s.id);
                      }
                    }}
                  />
                </label>
                <div className="flex min-w-32 items-center gap-2 md:justify-end">
                  <SecondaryButton
                    onClick={() => saveWage(s.id)}
                    // Saving an untouched row posts a no-op and reports a save
                    // that did not happen.
                    disabled={busy || savingWage === s.id || !dirty}
                  >
                    {savingWage === s.id ? "در حال ذخیره…" : "ذخیره"}
                  </SecondaryButton>
                  {dirty ? (
                    <span className="text-xs text-amber-700 dark:text-amber-300">ذخیره‌نشده</span>
                  ) : null}
                </div>
              </li>
              );
            })}
          </ul>

          {/* The month's wage bill at a glance: how many people carry a wage, and
              the sum a «ثبت تعهد» would post today. */}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/20 bg-amber-50/60 px-4 py-3 dark:bg-amber-500/10">
            <span className="text-sm text-muted-foreground">
              {toPersianDigits(payableStaff.length)} نفر از {toPersianDigits(staff.length)} کارمند حقوق تعیین‌شده دارند
            </span>
            <span className="text-sm font-semibold tabular-nums text-foreground">
              جمع حقوق ماهانه: {money.format(monthlyWageBill)}
            </span>
          </div>
          {dirtyCount > 0 ? (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {toPersianDigits(dirtyCount)} تغییر ذخیره‌نشده دارید؛ تا زمانی که «ذخیره» نزنید در تعهد حقوق اعمال نمی‌شود.
            </p>
          ) : null}
          </>
        )}
        </div>
      </section>

      <section aria-labelledby="payroll-accrual-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">ثبت دوره</p>
          <h2 id="payroll-accrual-heading" className="mt-1 text-base font-semibold text-foreground">تعهد حقوق و دستمزد جدید</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">ثبت تعهد، همان گردش سندداری موجود را اجرا می‌کند.</p>
        </header>
        <form onSubmit={accrue} className="grid gap-4 p-4 sm:p-5 md:grid-cols-[minmax(14rem,1fr)_12rem_auto] md:items-end">
          <div className="block text-sm font-medium">
            <label htmlFor={periodFieldId} className="mb-1.5 block text-xs text-muted-foreground">دوره</label>
            <input
              id={periodFieldId}
              className={inputClass}
              value={periodLabel}
              onChange={(e) => setPeriodLabel(e.target.value)}
              placeholder="مثلاً مرداد ۱۴۰۴"
              maxLength={PERIOD_LABEL_MAX}
              required
            />
          </div>
          <div className="block text-sm font-medium">
            {/*
              * The picker is a button + popover, not an <input>, so wrapping it
              * in a <label> gave it no accessible name at all. A real <label>
              * beside it plus the picker's own aria-label is what names it.
              */}
            <span className="mb-1.5 block text-xs text-muted-foreground" id={accrualFieldId}>
              تاریخ تعهد <span className="font-normal">(اختیاری)</span>
            </span>
            <JalaliDatePicker
              value={accrualDate}
              onChange={setAccrualDate}
              placeholder="امروز"
              labelledBy={accrualFieldId}
            />
          </div>
          <div className="min-w-40">
            <PrimaryButton disabled={busy || !periodLabel.trim() || payableStaff.length === 0}>
              {busy ? "در حال ثبت…" : "ثبت تعهد"}
            </PrimaryButton>
          </div>
          {/* A preview of exactly what the accrual will post — the payable staff
              and the total — so «ثبت تعهد» never surprises. */}
          <div className="md:col-span-3">
            {payableStaff.length === 0 ? (
              <EmptyState>هیچ کارمندی حقوق تعیین‌شده ندارد؛ ابتدا در بخش بالا حقوق ماهانه را وارد کنید.</EmptyState>
            ) : (
              <div className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    این تعهد ثبت خواهد شد ({toPersianDigits(payableStaff.length)} نفر)
                  </span>
                  <span className="text-sm font-semibold tabular-nums text-foreground">{money.format(monthlyWageBill)}</span>
                </div>
                <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">
                  {payableStaff.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate text-muted-foreground" title={s.fullName}>{s.fullName}</span>
                      <span className="shrink-0 tabular-nums text-foreground">{money.format(s.monthlyWage ?? 0)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </form>
      </section>

      <section aria-labelledby="payroll-history-heading" className={cardClass}>
        <header className="border-b border-border/80 px-4 py-4 sm:px-5">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">سوابق</p>
          <h2 id="payroll-history-heading" className="mt-1 text-base font-semibold text-foreground">تاریخچه حقوق و دستمزد</h2>
        </header>

        <div className="p-4 sm:p-5">
        {runs.length === 0 ? (
          <EmptyState>هنوز تعهدی ثبت نشده است.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {runs.map((r) => {
              const status = STATUS_TONES[r.status] ?? { label: r.status, tone: "neutral" as const };
              const rowWorking = rowBusy === r.id;
              return (
              <li key={r.id} className="rounded-xl border border-border/80 bg-muted/60 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
                  <div className="min-w-0">
                    <h3 className="break-words font-semibold text-foreground">{r.periodLabel}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">
                      تاریخ تعهد: {jalaliOrDash(r.accrualDate)}
                      {r.status === "paid" && r.paidDate ? ` — پرداخت: ${jalaliOrDash(r.paidDate)}` : ""}
                      {r.status === "voided" && r.voidedDate ? ` — ابطال: ${jalaliOrDash(r.voidedDate)}` : ""}
                    </p>
                    {r.createdByName ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">ثبت توسط: {r.createdByName}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={"font-bold tabular-nums " + (r.status === "voided" ? "text-muted-foreground line-through" : "text-foreground")}>
                      {money.format(r.totalAmount)}
                    </span>
                    <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  </div>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  {r.lines.map((l, i) => (
                    <div key={l.userId ?? `line-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-muted/60 px-3 py-2.5 text-sm">
                      {/* A line whose user was deleted keeps its amount; name it
                          rather than showing a bare dash. */}
                      <span className="min-w-0 truncate text-muted-foreground" title={l.fullName ?? undefined}>
                        {l.fullName ?? "عضو حذف‌شده"}
                      </span>
                      <span className="shrink-0 font-semibold tabular-nums text-foreground">{money.format(l.amount)}</span>
                    </div>
                  ))}
                </div>

                {r.status === "accrued" ? (
                  <div className="mt-4 grid gap-3 border-t border-border pt-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,14rem)_auto] sm:items-end">
                    <label className="block text-sm font-medium">
                      <span className="mb-1.5 block text-xs text-muted-foreground">پرداخت از</span>
                      <SearchableSelect
                        value={payMethod[r.id] ?? "cash"}
                        onChange={(value) => setPayMethod((prev) => ({ ...prev, [r.id]: value as "cash" | "bank" }))}
                        ariaLabel={`حساب پرداخت حقوق دوره ${r.periodLabel}`}
                        options={[
                          { value: "cash", label: "صندوق (نقدی)" },
                          { value: "bank", label: "بانکی" },
                        ]}
                      />
                    </label>
                    <SecondaryButton onClick={() => pay(r.id)} disabled={busy || rowWorking}>
                      {rowWorking ? "در حال ثبت…" : "ثبت پرداخت حقوق"}
                    </SecondaryButton>
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => setVoidTarget(r)}
                      disabled={busy || rowWorking}
                      aria-label={`ابطال تعهد دوره ${r.periodLabel}`}
                    >
                      ابطال تعهد
                    </Button>
                  </div>
                ) : null}

                {r.status === "paid" ? (
                  <div className="mt-4 flex justify-end border-t border-border pt-3">
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={() => setVoidTarget(r)}
                      disabled={busy || rowWorking}
                      aria-label={`ابطال تعهد و پرداخت دوره ${r.periodLabel}`}
                    >
                      {rowWorking ? "در حال ابطال…" : "ابطال (برگشت تعهد و پرداخت)"}
                    </Button>
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
        </div>
      </section>

      {/*
        * «ابطال» asks in a real dialog rather than `window.confirm`: the native
        * one is unstyled, LTR, unreadable on a phone, and shows the raw string
        * with no emphasis on the amount being reversed. This one names the
        * period, the amount and exactly which entries will be mirrored.
        */}
      <Dialog open={voidTarget !== null} onOpenChange={(open) => !open && setVoidTarget(null)}>
        <DialogContent dir="rtl" className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>ابطال تعهد حقوق</DialogTitle>
            <DialogDescription className="leading-6">
              {voidTarget ? (
                <>
                  دوره «{voidTarget.periodLabel}» به مبلغ{" "}
                  <span className="font-semibold text-foreground">{money.format(voidTarget.totalAmount)}</span>{" "}
                  {voidTarget.status === "paid"
                    ? "ابطال می‌شود؛ هم سند تعهد و هم سند پرداخت با اسناد معکوس (به تاریخ امروز) برگشت می‌خورند."
                    : "ابطال می‌شود؛ سند تعهد با یک سند معکوس (به تاریخ امروز) برگشت می‌خورد."}{" "}
                  این کار قابل بازگشت نیست.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:justify-start">
            <Button type="button" variant="destructive" onClick={confirmVoid} disabled={busy}>
              ابطال تعهد
            </Button>
            <Button type="button" variant="outline" onClick={() => setVoidTarget(null)}>
              انصراف
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
