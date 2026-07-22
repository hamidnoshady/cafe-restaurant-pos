"use client";

import { useCallback, useEffect, useState } from "react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali, jalaliToIsoDate, todayJalali } from "@/lib/jalali";
import { isNoShowOverdue } from "@/lib/reservations";
import { JalaliDatePicker } from "../jalali-date-picker";
import { api, ErrorBox, errorMessage, Field, inputClass, PrimaryButton, SecondaryButton } from "../ui";

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

const STATUS_LABELS: Record<Reservation["status"], string> = {
  booked: "رزرو",
  seated: "نشسته",
  completed: "تکمیل",
  cancelled: "لغو",
  no_show: "عدم حضور",
};
const STATUS_STYLE: Record<Reservation["status"], string> = {
  booked: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  seated: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground line-through",
  no_show: "bg-destructive/10 text-destructive",
};

function tehranTime(iso: string): string {
  return toPersianDigits(
    new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran" }),
  );
}

export function ReservationsManager({ canBook }: { canBook: boolean }) {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const [rRes, tRes] = await Promise.all([
      api<{ reservations: Reservation[] }>("/api/reservations"),
      api<{ tables: Table[] }>("/api/tables"),
    ]);
    if (rRes.ok) setReservations(rRes.data.reservations);
    if (tRes.ok) setTables(tRes.data.tables);
    setLoaded(true);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function seat(id: string) {
    setError("");
    const res = await api<{ error?: string }>(`/api/reservations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action: "seat" }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    load();
  }
  async function changeStatus(id: string, action: "cancel" | "no_show") {
    setError("");
    const res = await api<{ error?: string }>(`/api/reservations/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    load();
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  const now = Date.now();

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <div className="flex-1">
        <ErrorBox>{error}</ErrorBox>
        {reservations.length === 0 ? (
          <p className="rounded-2xl bg-card p-6 text-sm text-muted-foreground shadow-sm">
            رزروی در بازهٔ پیش‌رو ثبت نشده است.
          </p>
        ) : (
          <ul className="space-y-2">
            {reservations.map((r) => {
              const overdue = r.status === "booked" && isNoShowOverdue(new Date(r.reserved_at).getTime(), now);
              return (
                <li
                  key={r.id}
                  className={`rounded-xl border bg-card p-4 shadow-sm ${overdue ? "border-destructive/40" : "border-border"}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold">
                        {r.customer_name}
                        {r.customer_phone ? (
                          <span className="ms-2 text-xs text-muted-foreground" dir="ltr">
                            {toPersianDigits(r.customer_phone)}
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {toPersianDigits(formatJalali(r.reserved_at, { withMonthName: true }))} · ساعت{" "}
                        {tehranTime(r.reserved_at)} · {toPersianDigits(r.party_size)} نفر
                        {r.table_name ? ` · میز ${r.table_name}` : " · بدون میز"}
                      </p>
                      {r.note ? <p className="mt-1 text-xs text-muted-foreground">{r.note}</p> : null}
                      {overdue ? <p className="mt-1 text-xs text-destructive">از زمان رزرو گذشته — احتمال عدم حضور</p> : null}
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${STATUS_STYLE[r.status]}`}>
                      {STATUS_LABELS[r.status]}
                    </span>
                  </div>
                  {r.status === "booked" ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <SecondaryButton onClick={() => seat(r.id)}>نشاندن روی میز</SecondaryButton>
                      <button
                        type="button"
                        onClick={() => changeStatus(r.id, "no_show")}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        ثبت عدم حضور
                      </button>
                      <button
                        type="button"
                        onClick={() => changeStatus(r.id, "cancel")}
                        className="text-xs text-muted-foreground hover:text-destructive"
                      >
                        لغو رزرو
                      </button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {canBook ? (
        <aside className="w-full shrink-0 lg:w-96">
          <BookingForm tables={tables} onBooked={load} />
        </aside>
      ) : null}
    </div>
  );
}

function todayIso(): string {
  const j = todayJalali();
  return jalaliToIsoDate(j.jy, j.jm, j.jd);
}

function BookingForm({ tables, onBooked }: { tables: Table[]; onBooked: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [partySize, setPartySize] = useState("2");
  const [date, setDate] = useState(todayIso());
  const [time, setTime] = useState("20:00");
  const [tableId, setTableId] = useState("");
  const [duration, setDuration] = useState("90");
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);
  const [busy, setBusy] = useState(false);

  function buildReservedAt(): string | null {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const t = toLatinDigits(time).trim();
    if (!/^\d{1,2}:\d{2}$/.test(t)) return null;
    const [hh, mm] = t.split(":");
    return `${date}T${hh.padStart(2, "0")}:${mm}:00${TEHRAN_OFFSET}`;
  }

  async function submit(allowConflict = false) {
    setError("");
    setConflicts(null);
    if (!name.trim()) return setError(errorMessage("missing_fields"));
    const reservedAt = buildReservedAt();
    if (!reservedAt) return setError(errorMessage("invalid_time"));

    setBusy(true);
    const res = await api<{ error?: string; conflicts?: Conflict[] }>("/api/reservations", {
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
    });
    setBusy(false);
    if (!res.ok) {
      if (res.status === 409 && res.data.error === "reservation_conflict") {
        setConflicts(res.data.conflicts ?? []);
        return;
      }
      return setError(errorMessage(res.data.error));
    }
    setName("");
    setPhone("");
    setNote("");
    setConflicts(null);
    onBooked();
  }

  return (
    <div className="rounded-2xl bg-card p-5 shadow-sm">
      <h2 className="mb-4 text-lg font-bold">رزرو جدید</h2>
      <ErrorBox>{error}</ErrorBox>

      <Field label="نام مهمان">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="تلفن (اختیاری)">
        <input className={inputClass} dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="تعداد نفرات">
          <input className={inputClass} inputMode="numeric" dir="ltr" value={partySize} onChange={(e) => setPartySize(e.target.value)} />
        </Field>
        <Field label="مدت (دقیقه)">
          <input className={inputClass} inputMode="numeric" dir="ltr" value={duration} onChange={(e) => setDuration(e.target.value)} />
        </Field>
      </div>

      <Field label="تاریخ (شمسی)">
        <JalaliDatePicker value={date} onChange={setDate} clearable={false} />
      </Field>
      <Field label="ساعت (۲۴ ساعته، مثل 20:00)">
        <input className={inputClass} dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} placeholder="HH:MM" />
      </Field>
      <Field label="میز (اختیاری — برای تشخیص تداخل لازم است)">
        <select className={inputClass} value={tableId} onChange={(e) => setTableId(e.target.value)}>
          <option value="">بدون میز مشخص</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="یادداشت (اختیاری)">
        <input className={inputClass} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>

      {conflicts ? (
        <div className="mb-4 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3 text-sm text-primary">
          <p className="mb-1 font-semibold">این میز در این بازه رزرو دیگری دارد:</p>
          <ul className="mb-2 list-disc pe-5 text-xs">
            {conflicts.map((c, i) => (
              <li key={i}>
                {c.customer_name} — ساعت {tehranTime(c.reserved_at)}
              </li>
            ))}
          </ul>
          <SecondaryButton onClick={() => submit(true)} disabled={busy}>
            به‌هرحال ثبت کن
          </SecondaryButton>
        </div>
      ) : null}

      <PrimaryButton type="button" onClick={() => submit(false)} disabled={busy}>
        {busy ? "در حال ثبت…" : "ثبت رزرو"}
      </PrimaryButton>
    </div>
  );
}
