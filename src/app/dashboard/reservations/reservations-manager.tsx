"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { CalendarDaysIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali, jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import { isNoShowOverdue } from "@/lib/reservations";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, ErrorBox, errorMessage, Field, inputClass } from "../ui";

// Iran no longer observes DST, so wall-clock Tehran time is a fixed +03:30.
const TEHRAN_OFFSET = "+03:30";

interface Reservation {
  id: string;
  table_id: string | null;
  table_name: string | null;
  customer_name: string;
  customer_phone: string | null;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
  status: "booked" | "seated" | "completed" | "cancelled" | "no_show";
  note: string | null;
  seated_session_id: string | null;
}

interface Table {
  id: string;
  name: string;
}

interface Conflict {
  customer_name: string;
  reserved_at: string;
}

type PanelMode = "none" | "form" | "details";
type ReservationAction = "seat" | "cancel" | "no_show";

const STATUS_META: Record<
  Reservation["status"],
  { label: string; toneClass: string; dotClass: string }
> = {
  booked: {
    label: "رزرو",
    toneClass: "border-[#F0D39C] bg-[#FFF7E8] text-[#835500]",
    dotClass: "bg-[#D69217]",
  },
  seated: {
    label: "نشسته",
    toneClass: "border-[#B9E3C8] bg-[#ECF8F0] text-[#1E7041]",
    dotClass: "bg-[#36B56A]",
  },
  completed: {
    label: "تکمیل",
    toneClass: "border-[#D9D6CF] bg-[#F5F3EE] text-[#5E5B55]",
    dotClass: "bg-[#77756F]",
  },
  cancelled: {
    label: "لغو",
    toneClass: "border-[#D9D6CF] bg-[#F5F3EE] text-[#77756F]",
    dotClass: "bg-[#9C9992]",
  },
  no_show: {
    label: "عدم حضور",
    toneClass: "border-[#E9B9AF] bg-[#FFF2EF] text-[#8A3126]",
    dotClass: "bg-[#AF3E2E]",
  },
};

function tehranTime(iso: string): string {
  return toPersianDigits(
    new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Tehran",
    }),
  );
}

function todayIso(): string {
  const day = todayJalali();
  return jalaliToIsoDate(day.jy, day.jm, day.jd);
}

function dayWindow(date: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = new Date(date + "T00:00:00" + TEHRAN_OFFSET);
  const end = new Date(date + "T23:59:59.999" + TEHRAN_OFFSET);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { from: start.toISOString(), to: end.toISOString() };
}

function formatRefreshTime(timestamp: number): string {
  return toPersianDigits(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "Asia/Tehran",
    }).format(timestamp),
  );
}

function ReservationStatusBadge({ status }: { status: Reservation["status"] }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={
        "inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold " +
        meta.toneClass
      }
    >
      <span
        className={"size-2 rounded-full " + meta.dotClass}
        aria-hidden="true"
      />
      {meta.label}
    </span>
  );
}

function ReservationSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_23rem]">
      <section
        className="rounded-xl border border-[#EAE8E2] bg-white p-4 md:col-start-1"
        aria-busy="true"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="h-5 w-36 animate-pulse rounded bg-[#F0EEE9] motion-reduce:animate-none" />
          <div className="h-6 w-16 animate-pulse rounded-md bg-[#F0EEE9] motion-reduce:animate-none" />
        </div>
        <div className="mt-4 space-y-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="rounded-xl border border-[#F0EFEB] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="h-5 w-32 animate-pulse rounded bg-[#F0EEE9] motion-reduce:animate-none" />
                  <div className="h-4 w-3/4 animate-pulse rounded bg-[#F0EEE9] motion-reduce:animate-none" />
                  <div className="h-4 w-1/2 animate-pulse rounded bg-[#F0EEE9] motion-reduce:animate-none" />
                </div>
                <div className="h-7 w-20 animate-pulse rounded-full bg-[#F0EEE9] motion-reduce:animate-none" />
              </div>
            </div>
          ))}
        </div>
      </section>
      <aside
        className="hidden rounded-xl border border-[#EAE8E2] bg-white p-4 md:col-start-2 md:block"
        aria-hidden="true"
      >
        <div className="h-5 w-28 animate-pulse rounded bg-[#F0EEE9] motion-reduce:animate-none" />
        <div className="mt-6 space-y-4">
          {[0, 1, 2, 3].map((item) => (
            <div key={item} className="space-y-2">
              <div className="h-3 w-20 animate-pulse rounded bg-[#F0EEE9] motion-reduce:animate-none" />
              <div className="h-[52px] w-full animate-pulse rounded-lg bg-[#F0EEE9] motion-reduce:animate-none" />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function EmptySchedule({
  canBook,
  onCreate,
}: {
  canBook: boolean;
  onCreate: () => void;
}) {
  return (
    <section className="rounded-xl border border-dashed border-[#DDD9D1] bg-[#FFFCF7] px-5 py-12 text-center">
      <p className="font-semibold text-[#36342F]">
        رزروی در بازهٔ پیش‌رو ثبت نشده است.
      </p>
      <p className="mt-2 text-sm leading-6 text-[#77756F]">
        برای این روز، رزروی در برنامهٔ میزها دیده نمی‌شود.
      </p>
      {canBook ? (
        <Button
          type="button"
          onClick={onCreate}
          className="mt-5 min-h-[52px] bg-[#E9A11B] px-5 font-semibold text-[#2B2418] hover:bg-[#D99110] focus-visible:ring-[#E9A11B]/45"
        >
          رزرو جدید
        </Button>
      ) : null}
    </section>
  );
}

function DetailsPlaceholder({ canBook }: { canBook: boolean }) {
  return (
    <section className="rounded-xl border border-dashed border-[#DDD9D1] bg-[#FFFCF7] p-6 text-center">
      <p className="font-semibold text-[#36342F]">
        {canBook
          ? "رزروی را انتخاب کنید یا رزرو جدید ثبت کنید"
          : "یک رزرو را انتخاب کنید"}
      </p>
      <p className="mt-2 text-sm leading-6 text-[#77756F]">
        جزئیات مهمان و اقدام‌های مجاز رزرو در این بخش نمایش داده می‌شود.
      </p>
    </section>
  );
}

function ReservationRow({
  reservation,
  selected,
  onSelect,
  now,
}: {
  reservation: Reservation;
  selected: boolean;
  onSelect: () => void;
  now: number;
}) {
  const overdue =
    reservation.status === "booked" &&
    isNoShowOverdue(new Date(reservation.reserved_at).getTime(), now);

  return (
    <article
      className={
        "overflow-hidden rounded-xl border bg-white shadow-[0_1px_2px_rgba(37,37,34,0.03)] transition-colors motion-reduce:transition-none " +
        (selected
          ? "border-[#E9A11B] ring-2 ring-[#E9A11B]/20"
          : overdue
            ? "border-[#E9B9AF]"
            : "border-[#EAE8E2]")
      }
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className="min-h-[116px] w-full p-4 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E9A11B]"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <time
              dateTime={reservation.reserved_at}
              className="text-lg font-bold tabular-nums text-[#252522]"
              dir="ltr"
            >
              {tehranTime(reservation.reserved_at)}
            </time>
            <p className="mt-1 truncate text-base font-semibold text-[#36342F]">
              {reservation.customer_name}
            </p>
          </div>
          <ReservationStatusBadge status={reservation.status} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-[#5E5B55]">
          <span>{toPersianDigits(reservation.party_size)} نفر</span>
          <span>{toPersianDigits(reservation.duration_minutes)} دقیقه</span>
          <span>
            {reservation.table_name
              ? "میز " + reservation.table_name
              : "بدون میز مشخص"}
          </span>
        </div>
        {overdue ? (
          <p className="mt-3 text-sm font-medium text-[#8A3126]">
            از زمان رزرو گذشته؛ احتمال عدم حضور
          </p>
        ) : null}
      </button>
    </article>
  );
}

function ReservationDetails({
  reservation,
  now,
  pendingAction,
  onAction,
}: {
  reservation: Reservation;
  now: number;
  pendingAction: string | null;
  onAction: (id: string, action: ReservationAction) => void;
}) {
  const overdue =
    reservation.status === "booked" &&
    isNoShowOverdue(new Date(reservation.reserved_at).getTime(), now);
  const actionKey = (action: ReservationAction) =>
    reservation.id + ":" + action;

  return (
    <section
      className="rounded-xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)]"
      aria-label={"جزئیات رزرو " + reservation.customer_name}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-[#77756F]">جزئیات رزرو</p>
          <h2 className="mt-1 break-words text-xl font-bold text-[#252522]">
            {reservation.customer_name}
          </h2>
        </div>
        <ReservationStatusBadge status={reservation.status} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-3 border-y border-[#F0EFEB] py-4 text-sm">
        <div>
          <dt className="text-xs text-[#77756F]">تاریخ</dt>
          <dd className="mt-1 font-semibold text-[#3C3A36]">
            {toPersianDigits(
              formatJalali(reservation.reserved_at, { withMonthName: true }),
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[#77756F]">ساعت</dt>
          <dd
            className="mt-1 font-semibold tabular-nums text-[#3C3A36]"
            dir="ltr"
          >
            {tehranTime(reservation.reserved_at)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[#77756F]">تعداد نفرات</dt>
          <dd className="mt-1 font-semibold text-[#3C3A36]">
            {toPersianDigits(reservation.party_size)} نفر
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[#77756F]">مدت</dt>
          <dd className="mt-1 font-semibold text-[#3C3A36]">
            {toPersianDigits(reservation.duration_minutes)} دقیقه
          </dd>
        </div>
      </dl>

      <dl className="mt-5 space-y-4 text-sm">
        <div>
          <dt className="text-xs text-[#77756F]">تلفن</dt>
          <dd className="mt-1 font-semibold text-[#3C3A36]" dir="ltr">
            {reservation.customer_phone
              ? toPersianDigits(reservation.customer_phone)
              : "ثبت نشده"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[#77756F]">میز</dt>
          <dd className="mt-1 font-semibold text-[#3C3A36]">
            {reservation.table_name
              ? "میز " + reservation.table_name
              : "بدون میز مشخص"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-[#77756F]">یادداشت</dt>
          <dd className="mt-1 break-words font-semibold leading-6 text-[#3C3A36]">
            {reservation.note || "ثبت نشده"}
          </dd>
        </div>
      </dl>

      {overdue ? (
        <p className="mt-5 rounded-lg border border-[#E9B9AF] bg-[#FFF7F5] px-3 py-2 text-sm font-medium text-[#8A3126]">
          از زمان رزرو گذشته است؛ در صورت لزوم عدم حضور مهمان را ثبت کنید.
        </p>
      ) : null}

      {reservation.status === "booked" ? (
        <div className="mt-5 space-y-3 border-t border-[#F0EFEB] pt-4">
          <Button
            type="button"
            size="lg"
            onClick={() => onAction(reservation.id, "seat")}
            disabled={pendingAction !== null}
            className="min-h-[52px] w-full bg-[#E9A11B] font-semibold text-[#2B2418] hover:bg-[#D99110] focus-visible:ring-[#E9A11B]/45"
          >
            {pendingAction === actionKey("seat")
              ? "در حال نشاندن…"
              : "نشاندن روی میز"}
          </Button>
          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction(reservation.id, "no_show")}
              disabled={pendingAction !== null}
              className="min-h-[52px] border-[#E1DDD5] bg-[#FFFCF7] text-[#5E5B55] hover:bg-[#FFF5E5]"
            >
              {pendingAction === actionKey("no_show")
                ? "در حال ثبت…"
                : "ثبت عدم حضور"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onAction(reservation.id, "cancel")}
              disabled={pendingAction !== null}
              className="min-h-[52px] border-[#E9B9AF] bg-white text-[#8A3126] hover:bg-[#FFF0ED]"
            >
              {pendingAction === actionKey("cancel")
                ? "در حال لغو…"
                : "لغو رزرو"}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BookingForm({
  tables,
  initialDate,
  onBooked,
}: {
  tables: Table[];
  initialDate: string;
  onBooked: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState("20:00");
  const [tableId, setTableId] = useState("");
  const [duration, setDuration] = useState("90");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [busy, setBusy] = useState(false);

  const fieldClass =
    inputClass +
    " min-h-[52px] border-[#DDD9D1] bg-[#FFFEFC] text-[#36342F] focus-visible:border-[#E9A11B] focus-visible:ring-[#E9A11B]/30";

  function buildReservedAt(): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const normalizedTime = toLatinDigits(time).trim();
    if (!/^\d{1,2}:\d{2}$/.test(normalizedTime)) return null;
    const parts = normalizedTime.split(":");
    return (
      date +
      "T" +
      parts[0].padStart(2, "0") +
      ":" +
      parts[1] +
      ":00" +
      TEHRAN_OFFSET
    );
  }

  async function submit(allowConflict = false) {
    setError("");
    setConflicts(null);
    if (!name.trim()) {
      setError(errorMessage("missing_fields"));
      return;
    }
    const reservedAt = buildReservedAt();
    if (!reservedAt) {
      setError(errorMessage("invalid_time"));
      return;
    }

    setBusy(true);
    try {
      const result = await api<{ error?: string; conflicts?: Conflict[] }>(
        "/api/reservations",
        {
          method: "POST",
          body: JSON.stringify({
            customerName: name.trim(),
            customerPhone: phone.trim() || undefined,
            partySize: Number(toLatinDigits(partySize)) || undefined,
            reservedAt,
            durationMinutes: Number(toLatinDigits(duration)) || undefined,
            tableId: tableId || undefined,
            note: note.trim() || undefined,
            allowConflict,
          }),
        },
      );

      if (!result.ok) {
        if (
          result.status === 409 &&
          result.data.error === "reservation_conflict"
        ) {
          setConflicts(result.data.conflicts ?? []);
          return;
        }
        setError(errorMessage(result.data.error));
        return;
      }

      setName("");
      setPhone("");
      setNote("");
      setConflicts(null);
      onBooked();
    } catch {
      setError("ثبت رزرو ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="rounded-xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(false);
      }}
      noValidate
    >
      <div className="mb-5">
        <p className="text-xs font-medium text-[#77756F]">ثبت رزرو</p>
        <h2 className="mt-1 text-xl font-bold text-[#252522]">رزرو جدید</h2>
      </div>
      <ErrorBox>{error}</ErrorBox>

      <Field label="نام مهمان">
        <input
          className={fieldClass}
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          aria-required="true"
        />
      </Field>
      <Field label="تلفن (اختیاری)">
        <input
          className={fieldClass}
          dir="ltr"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          autoComplete="tel"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="تعداد نفرات">
          <PersianNumberInput
            className={fieldClass}
            inputMode="numeric"
            dir="ltr"
            value={partySize}
            onChange={(event) => setPartySize(event.target.value)}
            aria-required="true"
          />
        </Field>
        <Field label="مدت (دقیقه)">
          <PersianNumberInput
            className={fieldClass}
            inputMode="numeric"
            dir="ltr"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            aria-required="true"
          />
        </Field>
      </div>
      <Field label="تاریخ (شمسی)">
        <JalaliDatePicker
          value={date}
          onChange={setDate}
          clearable={false}
          className={fieldClass}
        />
      </Field>
      <Field label="ساعت (۲۴ ساعته، مثل 20:00)">
          <input
            className={fieldClass}
            dir="ltr"
            inputMode="numeric"
            value={toPersianDigits(time)}
            onChange={(event) => setTime(toLatinDigits(event.target.value))}
            placeholder="HH:MM"
            aria-required="true"
          />
      </Field>
      <Field label="میز (اختیاری — برای تشخیص تداخل لازم است)">
        <SearchableSelect
          className={fieldClass}
          value={tableId}
          onChange={setTableId}
          options={[
            { value: "", label: "بدون میز مشخص" },
            ...tables.map((table) => ({ value: table.id, label: table.name })),
          ]}
        />
      </Field>
      <Field label="یادداشت (اختیاری)">
        <input
          className={fieldClass}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>

      {conflicts ? (
        <section
          className="mb-4 rounded-lg border border-[#F0D39C] bg-[#FFF8EA] px-4 py-3 text-sm text-[#7B5100]"
          role="alert"
        >
          <p className="font-semibold">این میز در این بازه رزرو دیگری دارد:</p>
          <ul className="mt-2 list-disc space-y-1 pe-5 text-xs">
            {conflicts.map((conflict, index) => (
              <li key={conflict.customer_name + conflict.reserved_at + index}>
                {conflict.customer_name} — ساعت{" "}
                {tehranTime(conflict.reserved_at)}
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="outline"
            onClick={() => void submit(true)}
            disabled={busy}
            className="mt-3 min-h-[52px] border-[#D9AE5B] bg-white text-[#6E4800] hover:bg-[#FFF3DB]"
          >
            به‌هرحال ثبت کن
          </Button>
        </section>
      ) : null}

      <Button
        type="submit"
        size="lg"
        disabled={busy}
        className="min-h-[52px] w-full bg-[#E9A11B] font-semibold text-[#2B2418] hover:bg-[#D99110] focus-visible:ring-[#E9A11B]/45"
      >
        {busy ? "در حال ثبت…" : "ثبت رزرو"}
      </Button>
    </form>
  );
}

export function ReservationsManager({ canBook }: { canBook: boolean }) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [selectedDate, setSelectedDate] = useState(todayIso);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelMode, setPanelMode] = useState<PanelMode>("none");
  const [loaded, setLoaded] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const requestId = useRef(0);
  const hasLoaded = useRef(false);

  const load = useCallback(
    async ({ showRefresh = false }: { showRefresh?: boolean } = {}) => {
      const currentRequest = ++requestId.current;
      if (showRefresh) setIsRefreshing(true);
      const window = dayWindow(selectedDate);
      const reservationsUrl = window
        ? "/api/reservations?from=" +
          encodeURIComponent(window.from) +
          "&to=" +
          encodeURIComponent(window.to)
        : "/api/reservations";

      try {
        const results = await Promise.all([
          api<{ reservations: Reservation[] }>(reservationsUrl),
          api<{ tables: Table[] }>("/api/tables"),
        ]);
        if (currentRequest !== requestId.current) return;

        const reservationsResult = results[0];
        const tablesResult = results[1];
        if (!reservationsResult.ok) {
          setLoadError(
            errorMessage((reservationsResult.data as { error?: string }).error),
          );
          return;
        }

        const nextReservations = reservationsResult.data.reservations ?? [];
        setReservations(nextReservations);
        setSelectedId((current) =>
          current &&
          !nextReservations.some((reservation) => reservation.id === current)
            ? null
            : current,
        );
        if (!tablesResult.ok) {
          setLoadError(
            "فهرست میزها دریافت نشد. برای تلاش دوباره، صفحه را به‌روزرسانی کنید.",
          );
        } else {
          setTables(tablesResult.data.tables ?? []);
          setLoadError("");
        }
        setLastUpdatedAt(Date.now());
      } catch {
        if (currentRequest === requestId.current) {
          setLoadError(
            "دریافت رزروها ممکن نشد. اتصال را بررسی کنید و دوباره تلاش کنید.",
          );
        }
      } finally {
        if (currentRequest === requestId.current) {
          setLoaded(true);
          setIsRefreshing(false);
        }
      }
    },
    [selectedDate],
  );

  useEffect(() => {
    const showRefresh = hasLoaded.current;
    hasLoaded.current = true;
    void load({ showRefresh });
  }, [load]);

  useEffect(() => {
    const syncOnlineState = () => setIsOnline(navigator.onLine);
    syncOnlineState();
    window.addEventListener("online", syncOnlineState);
    window.addEventListener("offline", syncOnlineState);
    return () => {
      window.removeEventListener("online", syncOnlineState);
      window.removeEventListener("offline", syncOnlineState);
    };
  }, []);

  useEffect(() => {
    if (
      selectedId &&
      !reservations.some((reservation) => reservation.id === selectedId)
    ) {
      setSelectedId(null);
      setPanelMode("none");
    }
  }, [reservations, selectedId]);

  const selectedReservation = useMemo(
    () =>
      reservations.find((reservation) => reservation.id === selectedId) ?? null,
    [reservations, selectedId],
  );
  const now = Date.now();
  const scheduleLabel = toPersianDigits(
    formatJalali(selectedDate + "T12:00:00" + TEHRAN_OFFSET, {
      withMonthName: true,
    }),
  );
  const syncLabel = !isOnline
    ? "اتصال اینترنت در دسترس نیست"
    : isRefreshing
      ? "در حال به‌روزرسانی"
      : lastUpdatedAt
        ? "به‌روزرسانی " + formatRefreshTime(lastUpdatedAt)
        : "در حال دریافت رزروها";

  function openNewReservation() {
    setSelectedId(null);
    setPanelMode("form");
  }

  function openDetails(id: string) {
    setSelectedId(id);
    setPanelMode("details");
  }

  async function performAction(id: string, action: ReservationAction) {
    setActionError("");
    const actionKey = id + ":" + action;
    setPendingAction(actionKey);
    try {
      const result = await api<{ error?: string }>("/api/reservations/" + id, {
        method: "PATCH",
        body: JSON.stringify({ action }),
      });
      if (!result.ok) {
        setActionError(errorMessage(result.data.error));
        return;
      }
      await load({ showRefresh: true });
    } catch {
      setActionError("ثبت تغییر ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setPendingAction(null);
    }
  }

  const desktopPanel =
    panelMode === "details" && selectedReservation ? (
      <ReservationDetails
        reservation={selectedReservation}
        now={now}
        pendingAction={pendingAction}
        onAction={performAction}
      />
    ) : canBook ? (
      <BookingForm
        tables={tables}
        initialDate={selectedDate}
        onBooked={() => void load({ showRefresh: true })}
      />
    ) : (
      <DetailsPlaceholder canBook={false} />
    );

  return (
    <div className="space-y-4" dir="rtl">
      <header className="rounded-xl border border-[#EAE8E2] bg-white p-4 shadow-[0_1px_2px_rgba(37,37,34,0.03)]">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-end sm:gap-5">
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-[#252522]">رزروها</h1>
              <p className="mt-1 text-sm text-[#77756F]">{scheduleLabel}</p>
            </div>
            <label className="block min-w-0 sm:w-56">
              <span className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-[#5E5B55]">
                <CalendarDaysIcon className="size-4" aria-hidden="true" />
                روز رزرو
              </span>
              <JalaliDatePicker
                value={selectedDate}
                onChange={(value) => {
                  if (value) setSelectedDate(value);
                }}
                clearable={false}
                className="min-h-[52px] border-[#DDD9D1] bg-[#FFFEFC] px-3 text-[#36342F] focus-visible:border-[#E9A11B] focus-visible:ring-[#E9A11B]/30"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <p
              className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 text-sm text-[#5E5B55] sm:flex-none"
              role="status"
              aria-live="polite"
            >
              <span
                className={
                  "size-2.5 shrink-0 rounded-full " +
                  (isOnline ? "bg-[#36B56A]" : "bg-[#D69217]")
                }
                aria-hidden="true"
              />
              <span className="truncate">{syncLabel}</span>
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void load({ showRefresh: true })}
              className="min-h-[52px] shrink-0 border-[#E1DDD5] bg-[#FFFCF7] px-4 text-[#3C3A36] hover:bg-[#FFF5E5]"
            >
              <RefreshCwIcon
                className={
                  "size-4 " +
                  (isRefreshing
                    ? "animate-spin motion-reduce:animate-none"
                    : "")
                }
                aria-hidden="true"
              />
              {isRefreshing ? "در حال به‌روزرسانی" : "به‌روزرسانی"}
            </Button>
            {canBook ? (
              <Button
                type="button"
                onClick={openNewReservation}
                className="min-h-[52px] shrink-0 bg-[#E9A11B] px-5 font-semibold text-[#2B2418] hover:bg-[#D99110] focus-visible:ring-[#E9A11B]/45"
              >
                رزرو جدید
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      {loadError ? (
        <section
          className="flex flex-col gap-3 rounded-xl border border-[#E9B9AF] bg-[#FFF7F5] p-4 text-[#8A3126] sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p className="text-sm font-medium">{loadError}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void load({ showRefresh: true })}
            className="min-h-[48px] shrink-0 border-[#E9B9AF] bg-white text-[#8A3126] hover:bg-[#FFF0ED]"
          >
            تلاش دوباره
          </Button>
        </section>
      ) : null}

      <ErrorBox>{actionError}</ErrorBox>

      {!loaded ? (
        <ReservationSkeleton />
      ) : (
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_20rem] lg:grid-cols-[minmax(0,1fr)_23rem]">
          <section className="min-w-0 rounded-xl border border-[#EAE8E2] bg-[#FFFEFC] p-3 sm:p-4 md:col-start-1">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-bold text-[#36342F]">برنامهٔ روز</h2>
                <p className="mt-1 text-sm text-[#77756F]">
                  به‌ترتیب ساعت رزرو
                </p>
              </div>
              <span className="shrink-0 rounded-md bg-[#F4F2ED] px-2.5 py-1 text-xs font-semibold text-[#5E5B55]">
                {toPersianDigits(reservations.length)} رزرو
              </span>
            </div>

            {reservations.length === 0 ? (
              <EmptySchedule canBook={canBook} onCreate={openNewReservation} />
            ) : (
              <div className="space-y-3">
                {reservations.map((reservation) => (
                  <ReservationRow
                    key={reservation.id}
                    reservation={reservation}
                    selected={reservation.id === selectedId}
                    onSelect={() => openDetails(reservation.id)}
                    now={now}
                  />
                ))}
              </div>
            )}
          </section>

          <aside className="hidden min-w-0 md:col-start-2 md:block">
            <div className="md:sticky md:top-4">{desktopPanel}</div>
          </aside>

          <aside className="md:hidden">
            {panelMode === "details" && selectedReservation ? (
              <ReservationDetails
                reservation={selectedReservation}
                now={now}
                pendingAction={pendingAction}
                onAction={performAction}
              />
            ) : panelMode === "form" && canBook ? (
              <BookingForm
                tables={tables}
                initialDate={selectedDate}
                onBooked={() => void load({ showRefresh: true })}
              />
            ) : null}
          </aside>
        </div>
      )}
    </div>
  );
}
