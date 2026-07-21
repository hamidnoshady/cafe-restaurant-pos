"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman } from "@/lib/money";
import { api, errorMessage, inputClass, PrimaryButton, SecondaryButton } from "../ui";

interface SessionDetail {
  session: {
    id: string;
    status: string;
    party_size: number | null;
    guest_name: string | null;
    opened_at: string;
    bill_requested_at: string | null;
    note: string | null;
  };
  tables: { id: string; name: string; capacity: number }[];
  orders: {
    id: string;
    order_number: number;
    status: string;
    subtotal: number | string;
    total: number | string;
    opened_at: string;
  }[];
  bill: { total: number; lines: { orderItemId: string; orderId: string; name: string; amount: number }[] };
}

export function SessionPanel({
  sessionId,
  onChange,
  setError,
}: {
  sessionId: string;
  onChange: () => void;
  setError: (s: string) => void;
}) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [freeTables, setFreeTables] = useState<{ id: string; name: string }[]>([]);
  const [mergeTableId, setMergeTableId] = useState("");
  const [showSplit, setShowSplit] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await api<SessionDetail>(`/api/table-sessions/${sessionId}`);
    if (res.ok) setDetail(res.data);
    const tRes = await api<{ tables: { id: string; name: string; status: string }[] }>("/api/tables");
    if (tRes.ok) setFreeTables(tRes.data.tables.filter((t) => t.status === "free"));
  }, [sessionId]);
  useEffect(() => {
    load();
  }, [load]);

  async function action(body: object) {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string }>(`/api/table-sessions/${sessionId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    await load();
    onChange();
  }

  if (!detail) return <p className="mt-4 text-xs text-stone-400">در حال بارگذاری نشست…</p>;

  const { session, tables, orders, bill } = detail;

  return (
    <div className="mt-4 border-t border-stone-200 pt-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-bold">نشست میز</h3>
        <span className="text-xs text-stone-500">
          {session.party_size ? `${toPersianDigits(session.party_size)} نفر` : "—"}
          {session.guest_name ? ` · ${session.guest_name}` : ""}
        </span>
      </div>
      {tables.length > 1 ? (
        <p className="mb-2 text-xs text-stone-500">میزهای ادغام‌شده: {tables.map((t) => t.name).join("، ")}</p>
      ) : null}

      <div className="mb-3 rounded-lg bg-stone-50 p-3 text-sm">
        {orders.length === 0 ? (
          <p className="text-xs text-stone-400">هنوز سفارشی ثبت نشده است.</p>
        ) : (
          <ul className="space-y-1">
            {orders.map((o) => (
              <li key={o.id} className="flex justify-between">
                <span className="text-stone-600">
                  سفارش #{toPersianDigits(o.order_number)}
                  {o.status === "voided" ? " (باطل)" : ""}
                </span>
                <span>{formatToman(Number(o.total))}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-2 flex justify-between border-t border-stone-200 pt-2 font-bold">
          <span>جمع صورتحساب</span>
          <span>{formatToman(bill.total)}</span>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {!session.bill_requested_at ? (
          <SecondaryButton onClick={() => action({ action: "request_bill" })} disabled={busy}>
            درخواست صورتحساب
          </SecondaryButton>
        ) : (
          <span className="rounded-lg bg-purple-50 px-3 py-2 text-xs text-purple-700">صورتحساب درخواست شد</span>
        )}
        <SecondaryButton onClick={() => setShowSplit(true)} disabled={busy || bill.total <= 0}>
          تقسیم صورتحساب
        </SecondaryButton>
        <PrimaryButton type="button" onClick={() => action({ action: "close" })} disabled={busy}>
          بستن میز (تسویه)
        </PrimaryButton>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <select className={`${inputClass} py-1 text-xs`} value={mergeTableId} onChange={(e) => setMergeTableId(e.target.value)}>
          <option value="">ادغام با میز آزاد…</option>
          {freeTables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <SecondaryButton
          onClick={() => mergeTableId && action({ action: "merge", tableId: mergeTableId })}
          disabled={busy || !mergeTableId}
        >
          ادغام
        </SecondaryButton>
      </div>

      {showSplit ? (
        <SplitDialog sessionId={sessionId} bill={bill} onClose={() => setShowSplit(false)} setError={setError} />
      ) : null}
    </div>
  );
}

function SplitDialog({
  sessionId,
  bill,
  onClose,
  setError,
}: {
  sessionId: string;
  bill: SessionDetail["bill"];
  onClose: () => void;
  setError: (s: string) => void;
}) {
  const [mode, setMode] = useState<"even" | "itemized">("even");
  const [guests, setGuests] = useState("2");
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [shares, setShares] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);

  const guestCount = Math.max(1, Math.min(50, Number(guests) || 1));

  async function compute() {
    setBusy(true);
    setError("");
    setShares(null);
    const res = await api<{ error?: string; shares?: number[] }>(`/api/table-sessions/${sessionId}/split`, {
      method: "POST",
      body: JSON.stringify({
        mode,
        guests: guestCount,
        assignments: mode === "itemized" ? assignments : undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) return setError(errorMessage(res.data.error));
    setShares(res.data.shares ?? null);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-lg" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-bold">تقسیم صورتحساب</h3>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600">
            ✕
          </button>
        </div>

        <div className="mb-4 flex gap-1 rounded-lg bg-stone-100 p-1 text-sm">
          <button
            type="button"
            onClick={() => {
              setMode("even");
              setShares(null);
            }}
            className={`flex-1 rounded-md py-1.5 ${mode === "even" ? "bg-white shadow-sm" : "text-stone-500"}`}
          >
            تقسیم مساوی
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("itemized");
              setShares(null);
            }}
            className={`flex-1 rounded-md py-1.5 ${mode === "itemized" ? "bg-white shadow-sm" : "text-stone-500"}`}
          >
            به تفکیک اقلام
          </button>
        </div>

        <div className="mb-4 flex items-center gap-2 text-sm">
          <span>تعداد مهمان:</span>
          <input
            className={`${inputClass} w-24`}
            inputMode="numeric"
            dir="ltr"
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
          />
        </div>

        {mode === "itemized" ? (
          <div className="mb-4 max-h-56 space-y-1 overflow-y-auto rounded-lg border border-stone-200 p-2 text-sm">
            {bill.lines.map((l) => (
              <div key={l.orderItemId} className="flex items-center justify-between gap-2">
                <span className="flex-1 truncate">
                  {l.name} <span className="text-xs text-stone-400">{formatToman(l.amount)}</span>
                </span>
                <select
                  className={`${inputClass} w-28 py-1 text-xs`}
                  value={assignments[l.orderItemId] ?? ""}
                  onChange={(e) =>
                    setAssignments((prev) => {
                      const next = { ...prev };
                      if (e.target.value === "") delete next[l.orderItemId];
                      else next[l.orderItemId] = Number(e.target.value);
                      return next;
                    })
                  }
                >
                  <option value="">مشترک</option>
                  {Array.from({ length: guestCount }, (_, i) => (
                    <option key={i} value={i}>
                      مهمان {toPersianDigits(i + 1)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ) : null}

        <PrimaryButton type="button" onClick={compute} disabled={busy}>
          محاسبهٔ سهم‌ها
        </PrimaryButton>

        {shares ? (
          <div className="mt-4 rounded-lg bg-stone-50 p-3 text-sm">
            <p className="mb-2 font-semibold">سهم هر مهمان:</p>
            <ul className="space-y-1">
              {shares.map((s, i) => (
                <li key={i} className="flex justify-between">
                  <span>مهمان {toPersianDigits(i + 1)}</span>
                  <span className="font-medium">{formatToman(s)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-stone-200 pt-2 font-bold">
              <span>جمع</span>
              <span>{formatToman(shares.reduce((a, b) => a + b, 0))}</span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
