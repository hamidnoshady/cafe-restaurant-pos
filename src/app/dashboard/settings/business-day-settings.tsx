"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * روز کاری — the management panel for the branch's trading day.
 *
 * Optional by design: a branch that leaves it off keeps the calendar day it
 * always had, and the panel says so rather than hiding the choice. Turning it
 * on is one number — the hour the day starts — and everything else follows
 * from it: a café that sets 18:00 has business days running 18:00 → 18:00, so
 * its 18:00–03:00 service is one day on one date instead of an evening and a
 * morning either side of midnight.
 *
 * The second half is the manual close: "we have cashed up, start the next day
 * now" without waiting for the start time to come round. It resets what is on
 * screen — the dashboard KPIs, the orders screen's closed list — and moves no
 * money, which is why it can be undone with a single button.
 */
import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatStartTime } from "@/lib/business-day";
import { formatJalali } from "@/lib/jalali";
import { ErrorBox, InfoBox, api, errorMessage, inputClass } from "../ui";
import { SectionCard } from "../page-chrome";
import { Button } from "@/components/ui/button";

interface BusinessDayStatus {
  timeZone: string;
  startMinutes: number | null;
  enabled: boolean;
  businessDate: string;
  scheduledStart: string;
  scheduledEnd: string;
  windowStart: string;
  /** "shift" = the cashier cashed up, "manual" = «بستن روز کاری», null = still running. */
  closedBy: "manual" | "shift" | null;
  manuallyClosed: boolean;
  lastClosedAt: string | null;
  lastClosedByName: string | null;
  lastShiftEndedAt: string | null;
  hasOpenShift: boolean;
}

interface Closure {
  id: string;
  businessDate: string;
  closedAt: string;
  closedByName: string | null;
  note: string | null;
}

function formatMoment(iso: string | null): string {
  if (!iso) return "—";
  return toPersianDigits(
    formatJalali(iso, { withMonthName: true, withTime: true }),
  );
}

function formatDate(iso: string): string {
  return toPersianDigits(formatJalali(iso, { withMonthName: true }));
}

function formatClock(minutes: number): string {
  return toPersianDigits(formatStartTime(minutes));
}

export function BusinessDaySettings() {
  const [status, setStatus] = useState<BusinessDayStatus | null>(null);
  const [closures, setClosures] = useState<Closure[]>([]);
  const [locationName, setLocationName] = useState("");
  const [canManage, setCanManage] = useState(false);
  const [startTime, setStartTime] = useState("18:00");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      businessDay: BusinessDayStatus;
      locationName: string;
      closures: Closure[];
      canManage: boolean;
      error?: string;
    }>("/api/business-day");
    setLoaded(true);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setStatus(data.businessDay);
    setClosures(data.closures ?? []);
    setLocationName(data.locationName ?? "");
    setCanManage(data.canManage);
    if (data.businessDay.startMinutes !== null) {
      setStartTime(formatStartTime(data.businessDay.startMinutes));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function send(
    path: string,
    init: RequestInit,
    successMessage: string,
  ): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(path, init);
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice(successMessage);
    await load();
  }

  const save = () =>
    send(
      "/api/business-day",
      { method: "PATCH", body: JSON.stringify({ startTime }) },
      "ساعت شروع روز کاری ذخیره شد.",
    );

  const disable = () =>
    send(
      "/api/business-day",
      { method: "PATCH", body: JSON.stringify({ startTime: null }) },
      "روز کاری غیرفعال شد؛ از این پس روز تقویمی (نیمه‌شب تا نیمه‌شب) ملاک است.",
    );

  const closeDay = () =>
    send(
      "/api/business-day/close",
      { method: "POST" },
      "روز کاری بسته شد. داشبورد و فهرست سفارش‌ها از همین لحظه صفر شدند.",
    );

  const reopenDay = () =>
    send(
      "/api/business-day/close",
      { method: "DELETE" },
      "روز کاری دوباره باز شد.",
    );

  return (
    <SectionCard title={`روز کاری${locationName ? ` — ${locationName}` : ""}`}>
      <p className="mb-4 text-sm text-muted-foreground">
        اگر کار شعبه از شب تا بامداد ادامه دارد، ساعت شروع روز کاری را تعیین
        کنید تا کل یک سرویس — مثلاً ۱۸:۰۰ تا ۰۳:۰۰ بامداد — یک روز کاری واحد
        حساب شود و داشبورد، فهرست سفارش‌ها و گزارش‌ها نیمه‌شب دو تکه نشوند. این
        تنظیم اختیاری است؛ تا وقتی فعالش نکنید همه‌چیز مثل قبل بر مبنای روز
        تقویمی کار می‌کند.
      </p>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {!loaded ? (
        <LoadingSkeleton rows={3} />
      ) : null}

      {loaded && status ? (
        <>
          <div className="mb-5 rounded-xl border border-input px-4 py-3 text-sm">
            {status.enabled ? (
              <>
                <p className="font-medium">
                  روز کاری فعال است و از ساعت{" "}
                  {formatClock(status.startMinutes ?? 0)} شروع می‌شود.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  روز کاری جاری: {formatDate(status.businessDate)} — از{" "}
                  {formatMoment(status.scheduledStart)} تا{" "}
                  {formatMoment(status.scheduledEnd)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  آمار داشبورد و سفارش‌ها از {formatMoment(status.windowStart)}{" "}
                  شمرده می‌شود
                  {status.closedBy === "shift"
                    ? " (شیفت بسته شده؛ کار شب تمام شده است)"
                    : status.closedBy === "manual"
                      ? ` (روز به‌صورت دستی بسته شده${
                          status.lastClosedByName
                            ? ` توسط ${status.lastClosedByName}`
                            : ""
                        })`
                      : status.hasOpenShift
                        ? " (شیفت باز است)"
                        : ""}
                  .
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                روز کاری تعریف نشده است؛ مبنای گزارش‌ها و داشبورد، روز تقویمی
                شعبه (نیمه‌شب تا نیمه‌شب) است.
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">ساعت شروع روز کاری</span>
              <input
                className={inputClass + " w-36"}
                dir="ltr"
                type="time"
                step={60}
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </label>
            <Button type="button" onClick={save} disabled={busy}>
              {status.enabled ? "ذخیرهٔ ساعت شروع" : "فعال‌سازی روز کاری"}
            </Button>
            {status.enabled ? (
              <Button type="button" variant="outline" onClick={disable} disabled={busy}>
                غیرفعال‌کردن
              </Button>
            ) : null}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            تغییر ساعت شروع، گزارش‌های گذشته را هم بر همین مبنا دسته‌بندی
            می‌کند؛ هیچ سفارشی حذف یا جابه‌جا نمی‌شود.
          </p>

          {status.enabled && canManage ? (
            <div className="mt-6 border-t border-border/80 pt-5">
              <h3 className="mb-1 text-sm font-semibold">بستن دستی روز کاری</h3>
              <p className="mb-3 text-xs text-muted-foreground">
                معمولاً به این دکمه نیازی نیست: وقتی صندوق‌دار شیفتش را می‌بندد
                و کسی دیگر در شعبه شیفت باز ندارد، همان بستن شیفت پایانِ کار شب
                حساب می‌شود و داشبورد و فهرست سفارش‌ها خودبه‌خود برای شیفت بعد
                صفر می‌شوند. این دکمه برای شعبه‌ای است که کارکنانش شیفت ثبت
                نمی‌کنند. در هر دو حالت گزارش‌ها دست‌نخورده می‌مانند و هر فروشی
                در روز کاری خودش باقی است.
              </p>
              {status.manuallyClosed ? (
                <Button type="button" variant="outline" onClick={reopenDay} disabled={busy}>
                  بازکردن دوبارهٔ روز کاری
                </Button>
              ) : (
                <Button type="button" onClick={closeDay} disabled={busy}>
                  بستن روز کاری
                </Button>
              )}

              {closures.length > 0 ? (
                <div className="mt-4 space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    بسته‌شدن‌های اخیر
                  </p>
                  {closures.map((closure) => (
                    <p
                      key={closure.id}
                      className="text-xs text-muted-foreground"
                    >
                      روز {formatDate(closure.businessDate)} — بسته‌شده در{" "}
                      {formatMoment(closure.closedAt)}
                      {closure.closedByName
                        ? ` توسط ${closure.closedByName}`
                        : ""}
                    </p>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}
