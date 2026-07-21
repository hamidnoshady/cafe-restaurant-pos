"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BanIcon,
  CircleCheckIcon,
  ReceiptIcon,
  SparklesIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatToman } from "@/lib/money";
import { TABLE_STATUS_LABELS, type TableStatus } from "@/lib/table-sessions";
import { useRealtime } from "../use-realtime";
import { api, ErrorBox, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";
import { SessionPanel } from "./session-panel";

export interface FloorSection {
  id: string;
  name: string;
  color: string | null;
  assigned_waiter_id: string | null;
  waiter_name: string | null;
  sort_order: number;
}
export interface UpcomingReservation {
  id: string;
  customer_name: string;
  party_size: number;
  reserved_at: string;
  duration_minutes: number;
}
export interface FloorTable {
  id: string;
  name: string;
  section_id: string | null;
  capacity: number;
  status: TableStatus;
  pos_x: number;
  pos_y: number;
  width: number;
  height: number;
  shape: "rect" | "circle";
  sort_order: number;
  session_id: string | null;
  party_size: number | null;
  guest_name: string | null;
  session_opened_at: string | null;
  bill_requested_at: string | null;
  order_count: number | string;
  session_total: number | string;
  upcoming_reservation: UpcomingReservation | null;
}
interface Waiter {
  id: string;
  full_name: string;
}

const STATUS_STYLE: Record<TableStatus, string> = {
  free: "border-emerald-400 bg-emerald-50 text-emerald-900 dark:border-emerald-600 dark:bg-emerald-950 dark:text-emerald-200",
  seated: "border-primary bg-primary/10 text-primary",
  bill_requested:
    "border-purple-500 bg-purple-100 text-purple-900 dark:border-purple-500 dark:bg-purple-950 dark:text-purple-200",
  cleaning: "border-muted-foreground/40 bg-muted text-muted-foreground",
  out_of_service: "border-destructive/40 bg-destructive/5 text-destructive/80",
};
/* Status is never color-only: each state also carries an icon (and label in the legend). */
const STATUS_ICON: Record<TableStatus, LucideIcon> = {
  free: CircleCheckIcon,
  seated: UsersIcon,
  bill_requested: ReceiptIcon,
  cleaning: SparklesIcon,
  out_of_service: BanIcon,
};
const LEGEND: TableStatus[] = ["free", "seated", "bill_requested", "cleaning", "out_of_service"];
const GRID = 10;
const snap = (n: number) => Math.max(0, Math.round(n / GRID) * GRID);

export function FloorPlan({ canEdit }: { canEdit: boolean }) {
  const [sections, setSections] = useState<FloorSection[]>([]);
  const [tables, setTables] = useState<FloorTable[]>([]);
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    const res = await api<{ sections: FloorSection[]; tables: FloorTable[] }>("/api/floor");
    if (res.ok) {
      setSections(res.data.sections);
      setTables(res.data.tables);
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime(
    useCallback(
      (event) => {
        if (["table.status", "table_session.updated", "order.created", "order.updated"].includes(event.type)) load();
      },
      [load],
    ),
  );
  useEffect(() => {
    if (canEdit) api<{ waiters: Waiter[] }>("/api/staff").then((r) => r.ok && setWaiters(r.data.waiters));
  }, [canEdit]);

  const selected = tables.find((t) => t.id === selectedId) ?? null;

  if (!loaded) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div>
      <ErrorBox>{error}</ErrorBox>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        {canEdit ? (
          <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
            <button
              type="button"
              onClick={() => {
                setMode("view");
                setSelectedId(null);
              }}
              className={`rounded-md px-3 py-1.5 ${mode === "view" ? "bg-card shadow-sm" : "text-muted-foreground"}`}
            >
              نمای سالن
            </button>
            <button
              type="button"
              onClick={() => {
                setMode("edit");
                setSelectedId(null);
              }}
              className={`rounded-md px-3 py-1.5 ${mode === "edit" ? "bg-card shadow-sm" : "text-muted-foreground"}`}
            >
              ویرایش پلان
            </button>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {LEGEND.map((s) => {
            const Icon = STATUS_ICON[s];
            return (
              <span key={s} className="flex items-center gap-1.5">
                <span
                  className={`inline-flex size-4 items-center justify-center rounded-full border ${STATUS_STYLE[s]}`}
                >
                  <Icon className="size-2.5" />
                </span>
                {TABLE_STATUS_LABELS[s]}
              </span>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:flex-row">
        <Canvas
          tables={tables}
          sections={sections}
          mode={mode}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onMove={(id, x, y) => setTables((prev) => prev.map((t) => (t.id === id ? { ...t, pos_x: x, pos_y: y } : t)))}
          onPersistMove={async (id, x, y) => {
            const res = await api(`/api/tables/${id}`, { method: "PATCH", body: JSON.stringify({ posX: x, posY: y }) });
            if (!res.ok) setError(errorMessage((res.data as { error?: string }).error));
          }}
        />

        <aside className="w-full shrink-0 lg:w-96">
          {mode === "edit" ? (
            <EditorPanel
              sections={sections}
              tables={tables}
              waiters={waiters}
              selected={selected}
              onChange={load}
              setError={setError}
            />
          ) : selected ? (
            <ViewPanel table={selected} onChange={load} setError={setError} onClose={() => setSelectedId(null)} />
          ) : (
            <div className="rounded-2xl bg-card p-6 text-sm text-muted-foreground shadow-sm">
              میزی را برای مشاهده یا نشاندن مهمان انتخاب کنید.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ canvas */

function Canvas({
  tables,
  sections,
  mode,
  selectedId,
  onSelect,
  onMove,
  onPersistMove,
}: {
  tables: FloorTable[];
  sections: FloorSection[];
  mode: "view" | "edit";
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, x: number, y: number) => void;
  onPersistMove: (id: string, x: number, y: number) => void;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: string; dx: number; dy: number; moved: boolean } | null>(null);
  const sectionName = (id: string | null) => sections.find((s) => s.id === id)?.name;

  function onPointerDown(e: React.PointerEvent, t: FloorTable) {
    if (mode !== "edit") {
      onSelect(t.id);
      return;
    }
    const rect = canvasRef.current!.getBoundingClientRect();
    drag.current = { id: t.id, dx: e.clientX - rect.left - t.pos_x, dy: e.clientY - rect.top - t.pos_y, moved: false };
    onSelect(t.id);
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag.current) return;
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = snap(e.clientX - rect.left - drag.current.dx);
    const y = snap(e.clientY - rect.top - drag.current.dy);
    drag.current.moved = true;
    onMove(drag.current.id, x, y);
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved) {
      const t = tables.find((x) => x.id === d.id);
      if (t) onPersistMove(t.id, t.pos_x, t.pos_y);
    }
  }

  return (
    <div
      ref={canvasRef}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="relative min-h-[520px] flex-1 overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
      style={{
        backgroundImage:
          mode === "edit"
            ? "linear-gradient(to right,var(--border) 1px,transparent 1px),linear-gradient(to bottom,var(--border) 1px,transparent 1px)"
            : undefined,
        backgroundSize: `${GRID * 2}px ${GRID * 2}px`,
      }}
    >
      {tables.length === 0 ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
          هنوز میزی روی پلان نیست.
        </p>
      ) : null}
      {tables.map((t) => {
        const total = Number(t.session_total);
        const reserved = t.upcoming_reservation;
        return (
          <button
            key={t.id}
            type="button"
            onPointerDown={(e) => onPointerDown(e, t)}
            className={`absolute flex flex-col items-center justify-center border-2 p-1 text-center text-xs shadow-sm transition-[color,background-color,border-color,box-shadow,transform] duration-300 hover:shadow-md active:scale-[0.98] ${STATUS_STYLE[t.status]} ${
              selectedId === t.id ? "ring-2 ring-ring ring-offset-1 ring-offset-background" : ""
            } ${mode === "edit" ? "cursor-move" : "cursor-pointer"}`}
            style={{
              insetInlineStart: t.pos_x,
              top: t.pos_y,
              width: t.width,
              height: t.height,
              borderRadius: t.shape === "circle" ? "9999px" : "0.5rem",
            }}
          >
            <span className="flex items-center gap-1 font-bold leading-tight">
              {(() => {
                const Icon = STATUS_ICON[t.status];
                return <Icon className="size-3" />;
              })()}
              {t.name}
            </span>
            <span className="text-[10px] opacity-70">
              {toPersianDigits(t.capacity)} نفره{sectionName(t.section_id) ? ` · ${sectionName(t.section_id)}` : ""}
            </span>
            {t.session_id ? (
              <span className="mt-0.5 text-[10px] font-semibold">{formatToman(total)}</span>
            ) : null}
            {reserved && t.status === "free" ? (
              <span className="mt-0.5 rounded bg-sky-700 px-1 text-[9px] text-white dark:bg-sky-600">
                رزرو {toPersianDigits(formatJalali(reserved.reserved_at).slice(5))}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- view panel */

function ViewPanel({
  table,
  onChange,
  setError,
  onClose,
}: {
  table: FloorTable;
  onChange: () => void;
  setError: (s: string) => void;
  onClose: () => void;
}) {
  const [seating, setSeating] = useState(false);
  const [partySize, setPartySize] = useState("");
  const [guestName, setGuestName] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(body: object, url = `/api/tables/${table.id}`) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(url, { method: "PATCH", body: JSON.stringify(body) });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }

  async function seat() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>("/api/table-sessions", {
      method: "POST",
      body: JSON.stringify({
        tableId: table.id,
        partySize: partySize ? Number(partySize) : undefined,
        guestName: guestName || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setSeating(false);
    setPartySize("");
    setGuestName("");
    onChange();
  }

  return (
    <div className="rounded-2xl bg-card p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">میز {table.name}</h2>
          <p className="text-xs text-muted-foreground">
            {toPersianDigits(table.capacity)} نفره · {TABLE_STATUS_LABELS[table.status]}
          </p>
        </div>
        <button type="button" onClick={onClose} className="text-sm text-muted-foreground hover:text-foreground">
          ✕
        </button>
      </div>

      {table.upcoming_reservation ? (
        <div className="mb-3 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800 dark:border-sky-900 dark:bg-sky-950 dark:text-sky-200">
          رزرو پیش‌رو: {table.upcoming_reservation.customer_name} ·{" "}
          {toPersianDigits(formatJalali(table.upcoming_reservation.reserved_at, { withMonthName: true }))} ·{" "}
          {toPersianDigits(new Date(table.upcoming_reservation.reserved_at).toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
            timeZone: "Asia/Tehran",
          }))}
        </div>
      ) : null}

      {table.status === "free" ? (
        seating ? (
          <div className="space-y-3">
            <input
              className={inputClass}
              inputMode="numeric"
              dir="ltr"
              value={partySize}
              onChange={(e) => setPartySize(e.target.value)}
              placeholder="تعداد نفرات"
            />
            <input
              className={inputClass}
              value={guestName}
              onChange={(e) => setGuestName(e.target.value)}
              placeholder="نام مهمان (اختیاری)"
            />
            <div className="flex gap-2">
              <PrimaryButton type="button" onClick={seat} disabled={busy}>
                نشاندن مهمان
              </PrimaryButton>
              <SecondaryButton onClick={() => setSeating(false)}>انصراف</SecondaryButton>
            </div>
          </div>
        ) : (
          <PrimaryButton type="button" onClick={() => setSeating(true)}>
            باز کردن میز (نشاندن مهمان)
          </PrimaryButton>
        )
      ) : null}

      {table.status === "cleaning" ? (
        <PrimaryButton type="button" onClick={() => act({ status: "free" })} disabled={busy}>
          میز تمیز شد
        </PrimaryButton>
      ) : null}

      {table.status === "out_of_service" ? (
        <PrimaryButton type="button" onClick={() => act({ status: "free" })} disabled={busy}>
          بازگرداندن به سرویس
        </PrimaryButton>
      ) : null}

      {table.status === "free" && !seating ? (
        <button
          type="button"
          onClick={() => act({ status: "out_of_service" })}
          className="mt-3 block text-xs text-muted-foreground hover:text-destructive"
        >
          خارج کردن از سرویس
        </button>
      ) : null}

      {table.session_id ? (
        <SessionPanel sessionId={table.session_id} onChange={onChange} setError={setError} />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ editor panel */

function EditorPanel({
  sections,
  tables,
  waiters,
  selected,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  tables: FloorTable[];
  waiters: Waiter[];
  selected: FloorTable | null;
  onChange: () => void;
  setError: (s: string) => void;
}) {
  return (
    <div className="space-y-4">
      <SectionEditor sections={sections} waiters={waiters} onChange={onChange} setError={setError} />
      <AddTable sections={sections} onChange={onChange} setError={setError} />
      {selected ? (
        <TableEditor table={selected} sections={sections} onChange={onChange} setError={setError} />
      ) : (
        <div className="rounded-2xl bg-card p-4 text-xs text-muted-foreground shadow-sm">
          برای ویرایش یک میز، آن را روی پلان انتخاب کنید. برای جابه‌جایی، میز را بکشید.
        </div>
      )}
      <p className="text-xs text-muted-foreground">تعداد میزها: {toPersianDigits(tables.length)}</p>
    </div>
  );
}

function SectionEditor({
  sections,
  waiters,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  waiters: Waiter[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function addSection() {
    if (!name.trim()) return;
    setBusy(true);
    const res = await api<{ error?: string }>("/api/floor/sections", {
      method: "POST",
      body: JSON.stringify({ name: name.trim() }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setName("");
    onChange();
  }
  async function assignWaiter(id: string, waiterId: string) {
    const res = await api<{ error?: string }>(`/api/floor/sections/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ assignedWaiterId: waiterId || null }),
    });
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }
  async function removeSection(id: string) {
    const res = await api<{ error?: string }>(`/api/floor/sections/${id}`, { method: "DELETE" });
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }

  return (
    <div className="rounded-2xl bg-card p-4 shadow-sm">
      <h3 className="mb-3 font-bold">بخش‌ها و گارسون‌ها</h3>
      <div className="mb-3 flex gap-2">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام بخش جدید" />
        <SecondaryButton onClick={addSection} disabled={busy}>
          افزودن
        </SecondaryButton>
      </div>
      <ul className="space-y-2 text-sm">
        {sections.map((s) => (
          <li key={s.id} className="flex items-center gap-2">
            <span className="w-24 shrink-0 truncate">{s.name}</span>
            <select
              className={`${inputClass} py-1 text-xs`}
              value={s.assigned_waiter_id ?? ""}
              onChange={(e) => assignWaiter(s.id, e.target.value)}
            >
              <option value="">بدون گارسون</option>
              {waiters.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.full_name}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => removeSection(s.id)} className="text-xs text-destructive hover:underline">
              حذف
            </button>
          </li>
        ))}
        {sections.length === 0 ? <li className="text-xs text-muted-foreground">هنوز بخشی تعریف نشده است.</li> : null}
      </ul>
    </div>
  );
}

function AddTable({
  sections,
  onChange,
  setError,
}: {
  sections: FloorSection[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState("");
  const [capacity, setCapacity] = useState("4");
  const [sectionId, setSectionId] = useState("");
  const [shape, setShape] = useState<"rect" | "circle">("rect");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!name.trim()) return setError(errorMessage("missing_fields"));
    setBusy(true);
    const res = await api<{ error?: string }>("/api/tables", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        capacity: Number(capacity) || 2,
        sectionId: sectionId || undefined,
        shape,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setName("");
    onChange();
  }

  return (
    <div className="rounded-2xl bg-card p-4 shadow-sm">
      <h3 className="mb-3 font-bold">افزودن میز</h3>
      <div className="grid grid-cols-2 gap-2">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام/شماره میز" />
        <input
          className={inputClass}
          inputMode="numeric"
          dir="ltr"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="ظرفیت"
        />
        <select className={inputClass} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
          <option value="">بدون بخش</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className={inputClass} value={shape} onChange={(e) => setShape(e.target.value as "rect" | "circle")}>
          <option value="rect">مربع/مستطیل</option>
          <option value="circle">گرد</option>
        </select>
      </div>
      <div className="mt-3">
        <SecondaryButton onClick={add} disabled={busy}>
          افزودن میز
        </SecondaryButton>
      </div>
    </div>
  );
}

function TableEditor({
  table,
  sections,
  onChange,
  setError,
}: {
  table: FloorTable;
  sections: FloorSection[];
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [name, setName] = useState(table.name);
  const [capacity, setCapacity] = useState(String(table.capacity));
  const [sectionId, setSectionId] = useState(table.section_id ?? "");
  const [shape, setShape] = useState<"rect" | "circle">(table.shape);
  const [width, setWidth] = useState(String(table.width));
  const [height, setHeight] = useState(String(table.height));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(table.name);
    setCapacity(String(table.capacity));
    setSectionId(table.section_id ?? "");
    setShape(table.shape);
    setWidth(String(table.width));
    setHeight(String(table.height));
  }, [table]);

  async function save() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/tables/${table.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: name.trim(),
        capacity: Number(capacity) || 2,
        sectionId: sectionId || null,
        shape,
        width: Number(width) || 80,
        height: Number(height) || 80,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }
  async function remove() {
    setBusy(true);
    const res = await api<{ error?: string }>(`/api/tables/${table.id}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    onChange();
  }

  return (
    <div className="rounded-2xl bg-card p-4 shadow-sm">
      <h3 className="mb-3 font-bold">ویرایش میز {table.name}</h3>
      <div className="grid grid-cols-2 gap-2">
        <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="نام" />
        <input
          className={inputClass}
          inputMode="numeric"
          dir="ltr"
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          placeholder="ظرفیت"
        />
        <select className={inputClass} value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
          <option value="">بدون بخش</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className={inputClass} value={shape} onChange={(e) => setShape(e.target.value as "rect" | "circle")}>
          <option value="rect">مربع/مستطیل</option>
          <option value="circle">گرد</option>
        </select>
        <input
          className={inputClass}
          inputMode="numeric"
          dir="ltr"
          value={width}
          onChange={(e) => setWidth(e.target.value)}
          placeholder="عرض"
        />
        <input
          className={inputClass}
          inputMode="numeric"
          dir="ltr"
          value={height}
          onChange={(e) => setHeight(e.target.value)}
          placeholder="ارتفاع"
        />
      </div>
      <div className="mt-3 flex gap-2">
        <PrimaryButton type="button" onClick={save} disabled={busy}>
          ذخیره
        </PrimaryButton>
        <button type="button" onClick={remove} className="text-xs text-destructive hover:underline">
          حذف میز
        </button>
      </div>
    </div>
  );
}
