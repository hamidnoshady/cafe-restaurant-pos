"use client";

import { useCallback, useEffect, useState } from "react";
import { toPersianDigits } from "@/lib/digits";
import { formatToman, parseToRial } from "@/lib/money";
import {
  api,
  ErrorBox,
  errorMessage,
  InfoBox,
  inputClass,
  PrimaryButton,
  SecondaryButton,
  StepShell,
} from "../ui";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  children: string | number;
}

interface OpeningResponse {
  accounts: Account[];
  openingEntry: { id: string; entry_date: string; total: string } | null;
  inventoryItems: { id: string; name: string; unit: string; quantity: string }[];
  error?: string;
}

interface InvRow {
  name: string;
  unit: string;
  quantity: string;
  unitCost: string; // Toman input
}

interface BalanceRow {
  accountId: string;
  side: "debit" | "credit";
  amount: string; // Toman input
}

const emptyInvRow: InvRow = { name: "", unit: "kg", quantity: "", unitCost: "" };

export default function OpeningStep() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [openingEntry, setOpeningEntry] = useState<OpeningResponse["openingEntry"]>(null);
  const [existingInventory, setExistingInventory] = useState<OpeningResponse["inventoryItems"]>([]);

  const [invRows, setInvRows] = useState<InvRow[]>([{ ...emptyInvRow }]);
  const [balRows, setBalRows] = useState<BalanceRow[]>([{ accountId: "", side: "debit", amount: "" }]);
  const [autoOffset, setAutoOffset] = useState(true);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<OpeningResponse>("/api/setup/opening").then(({ data }) => {
      if (data.accounts) setAccounts(data.accounts);
      setOpeningEntry(data.openingEntry ?? null);
      setExistingInventory(data.inventoryItems ?? []);
    });
  }, []);
  useEffect(load, [load]);

  // Leaf accounts only — parents are grouping rows, not posting targets.
  const leafAccounts = accounts.filter((a) => Number(a.children) === 0);

  function parseTomanSafe(s: string): number | null {
    if (!s.trim()) return 0;
    try {
      const v = parseToRial(s, "toman");
      return v >= 0 ? v : null;
    } catch {
      return null;
    }
  }

  async function submitInventory() {
    setError("");
    setNotice("");
    const items = [];
    for (const r of invRows) {
      if (!r.name.trim()) continue;
      const quantity = Number(r.quantity);
      const unitCost = parseTomanSafe(r.unitCost);
      if (!Number.isFinite(quantity) || quantity <= 0 || unitCost === null) {
        return setError(`مقدار یا بهای «${r.name}» معتبر نیست.`);
      }
      items.push({ name: r.name, unit: r.unit, quantity, unitCost });
    }
    if (items.length === 0) return setError("حداقل یک قلم با نام و مقدار وارد کنید.");
    setBusy(true);
    const { ok, data } = await api<{ error?: string; totalValue?: number }>("/api/setup/opening", {
      method: "POST",
      body: JSON.stringify({ inventory: { items } }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error));
    setNotice(`شمارش ثبت شد — ارزش کل: ${formatToman(data.totalValue ?? 0)}.`);
    setInvRows([{ ...emptyInvRow }]);
    load();
  }

  const balTotals = balRows.reduce(
    (acc, r) => {
      const v = parseTomanSafe(r.amount) ?? 0;
      if (r.side === "debit") acc.debit += v;
      else acc.credit += v;
      return acc;
    },
    { debit: 0, credit: 0 },
  );

  async function submitBalances() {
    setError("");
    setNotice("");
    const lines = [];
    for (const r of balRows) {
      const amount = parseTomanSafe(r.amount);
      if (amount === null) return setError("یکی از مبلغ‌ها معتبر نیست.");
      if (!r.accountId || amount === 0) continue;
      lines.push({
        accountId: r.accountId,
        debit: r.side === "debit" ? amount : 0,
        credit: r.side === "credit" ? amount : 0,
      });
    }
    if (lines.length === 0) return setError("حداقل یک سطر با حساب و مبلغ لازم است.");
    setBusy(true);
    const { ok, data } = await api<{ error?: string; messages?: string[] }>("/api/setup/opening", {
      method: "POST",
      body: JSON.stringify({ balances: { lines, autoOffset } }),
    });
    setBusy(false);
    if (!ok) return setError(errorMessage(data.error, data.messages));
    setNotice("سند افتتاحیه با موفقیت ثبت شد (بدهکار = بستانکار).");
    load();
  }

  return (
    <StepShell
      step="opening"
      description="اگر موجودی و مانده‌حساب دارید، این‌جا ثبت کنید تا دفترها از روز اول درست باشند؛ اگر از صفر شروع می‌کنید این مرحله را رد کنید."
      showSkip
      showNext
    >
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <section className="mb-8 rounded-xl border border-border p-4">
        <h2 className="mb-1 font-semibold">۱) شمارش اولیهٔ انبار</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          هر قلم با مقدار شمارش‌شده و بهای هر واحد (تومان). با اولین ثبت، روش قیمت‌گذاری قفل می‌شود.
        </p>
        {existingInventory.length > 0 ? (
          <p className="mb-3 text-xs text-muted-foreground">
            اقلام ثبت‌شده: {existingInventory.map((i) => `${i.name} (${toPersianDigits(Number(i.quantity))} ${i.unit})`).join("، ")}
          </p>
        ) : null}
        <div className="space-y-2">
          {invRows.map((r, i) => (
            <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <input
                className={inputClass}
                placeholder="نام قلم (مثلاً قهوه)"
                value={r.name}
                onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              />
              <select
                className={inputClass}
                value={r.unit}
                onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
              >
                <option value="kg">کیلوگرم</option>
                <option value="g">گرم</option>
                <option value="l">لیتر</option>
                <option value="ml">میلی‌لیتر</option>
                <option value="unit">عدد</option>
              </select>
              <input
                className={inputClass}
                dir="ltr"
                inputMode="decimal"
                placeholder="مقدار"
                value={r.quantity}
                onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
              />
              <input
                className={inputClass}
                dir="ltr"
                inputMode="numeric"
                placeholder="بهای واحد (تومان)"
                value={r.unitCost}
                onChange={(e) => setInvRows((rs) => rs.map((x, j) => (j === i ? { ...x, unitCost: e.target.value } : x)))}
              />
              <button
                type="button"
                className="text-sm text-muted-foreground hover:text-destructive"
                onClick={() => setInvRows((rs) => rs.filter((_, j) => j !== i))}
              >
                حذف
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <SecondaryButton onClick={() => setInvRows((rs) => [...rs, { ...emptyInvRow }])}>
            افزودن قلم
          </SecondaryButton>
          <PrimaryButton type="button" onClick={submitInventory} disabled={busy}>
            ثبت شمارش
          </PrimaryButton>
        </div>
      </section>

      <section className="rounded-xl border border-border p-4">
        <h2 className="mb-1 font-semibold">۲) مانده‌های افتتاحیهٔ دفاتر</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          مانده‌ها به تومان. سند فقط وقتی ثبت می‌شود که بدهکار و بستانکار برابر باشند.
        </p>

        {openingEntry ? (
          <InfoBox>
            سند افتتاحیه قبلاً ثبت شده است (جمع: {formatToman(Number(openingEntry.total))}).
          </InfoBox>
        ) : (
          <>
            <div className="space-y-2">
              {balRows.map((r, i) => (
                <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <select
                    className={inputClass}
                    value={r.accountId}
                    onChange={(e) => setBalRows((rs) => rs.map((x, j) => (j === i ? { ...x, accountId: e.target.value } : x)))}
                  >
                    <option value="">حساب…</option>
                    {leafAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className={inputClass}
                    value={r.side}
                    onChange={(e) =>
                      setBalRows((rs) => rs.map((x, j) => (j === i ? { ...x, side: e.target.value as "debit" | "credit" } : x)))
                    }
                  >
                    <option value="debit">بدهکار</option>
                    <option value="credit">بستانکار</option>
                  </select>
                  <input
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    placeholder="مبلغ (تومان)"
                    value={r.amount}
                    onChange={(e) => setBalRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    className="text-sm text-muted-foreground hover:text-destructive"
                    onClick={() => setBalRows((rs) => rs.filter((_, j) => j !== i))}
                  >
                    حذف
                  </button>
                </div>
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
              <span>
                جمع بدهکار: <b>{formatToman(balTotals.debit)}</b>
              </span>
              <span>
                جمع بستانکار: <b>{formatToman(balTotals.credit)}</b>
              </span>
              <span className={balTotals.debit === balTotals.credit ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}>
                {balTotals.debit === balTotals.credit
                  ? "تراز است ✓"
                  : `اختلاف: ${formatToman(Math.abs(balTotals.debit - balTotals.credit))}`}
              </span>
            </div>

            <label className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={autoOffset} onChange={(e) => setAutoOffset(e.target.checked)} />
              اختلاف به‌طور خودکار به حساب «تراز افتتاحیه» (کد ۳۹۰۰) منظور شود
            </label>

            <div className="mt-4 flex gap-2">
              <SecondaryButton onClick={() => setBalRows((rs) => [...rs, { accountId: "", side: "debit", amount: "" }])}>
                افزودن سطر
              </SecondaryButton>
              <PrimaryButton type="button" onClick={submitBalances} disabled={busy}>
                ثبت سند افتتاحیه
              </PrimaryButton>
            </div>
          </>
        )}
      </section>
    </StepShell>
  );
}
