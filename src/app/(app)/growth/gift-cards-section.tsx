"use client";

/**
 * The Growth app's gift-card section (Phase 36b) — the issue/redeem counter
 * moved out of the old campaigns page into its own screen, because it is its
 * own liability: issuing a card takes the customer's cash and credits «کارت
 * هدیه» (۲۴۲۰); redeeming it debits that liability. Neither rule touches a
 * revenue account — the goods the card later buys are posted by the ordinary
 * sale path, so revenue can never be booked twice.
 */

import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useMoney } from "@/components/money/money-context";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

export function GiftCardsSection() {
  const money = useMoney();
  const [code, setCode] = useState("");
  const [issueValue, setIssueValue] = useState("");
  const [redeemCode, setRedeemCode] = useState("");
  const [redeemValue, setRedeemValue] = useState("");
  const [balance, setBalance] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  async function issue() {
    if (!code.trim() || !issueValue.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string }>("/api/promotions/gift-cards", {
      method: "POST",
      body: JSON.stringify({ code, initialValue: money.parse(issueValue) }),
    });
    setBusy(false);
    if (!ok) setError(data.message ?? "صدور کارت هدیه ناموفق بود.");
    else {
      setCode("");
      setIssueValue("");
      setDone("کارت هدیه صادر شد (بدهی ۲۴۲۰).");
    }
  }

  async function check() {
    if (!redeemCode.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ balance?: number; error?: string; message?: string }>(
      `/api/promotions/gift-cards?code=${encodeURIComponent(redeemCode.trim())}`,
    );
    setBusy(false);
    if (!ok || data.balance === undefined) {
      setBalance(null);
      setError((data.message ?? errorMessageOrRaw(data.error)) || "استعلام ماندهٔ کارت هدیه ناموفق بود.");
      return;
    }
    setBalance(data.balance);
  }

  async function redeem() {
    if (!redeemCode.trim() || !redeemValue.trim()) return;
    setBusy(true);
    setError("");
    const { ok, data } = await api<{ error?: string; message?: string; balance?: number }>("/api/promotions/gift-cards/redeem", {
      method: "POST",
      body: JSON.stringify({ code: redeemCode, amount: money.parse(redeemValue) }),
    });
    setBusy(false);
    if (!ok) setError(data.message ?? "مصرف کارت هدیه ناموفق بود.");
    else {
      setBalance(data.balance ?? null);
      setRedeemValue("");
      setDone("کارت هدیه مصرف شد.");
    }
  }

  return (
    <div className="space-y-4 sm:space-y-5">
      <ErrorBox>{error}</ErrorBox>
      {done ? <InfoBox>{done}</InfoBox> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">اعتبار هدیه</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">صدور کارت هدیه</h2>
            </div>
          }
          bodyClassName="space-y-3 p-4 sm:p-5"
        >
          <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="کد کارت جدید">
              <input className={inputClass} dir="ltr" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <Field label={`ارزش (${money.unitLabel})`}>
              <PersianNumberInput
                inputMode="numeric"
                className={inputClass}
                dir="ltr"
                value={issueValue}
                onChange={(e) => setIssueValue(e.target.value)}
              />
            </Field>
            <Button type="button" disabled={busy || !code.trim() || !issueValue.trim()} onClick={() => void issue()} className="min-h-11 w-full sm:w-auto">
              صدور
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            پول نقد بابت کارت وارد صندوق می‌شود و حساب ۲۴۲۰ بستانکار می‌گردد؛ درآمد همان‌جا ثبت می‌شود که مشتری با
            کارت خرید می‌کند — نه این‌جا.
          </p>
        </SectionCard>

        <SectionCard
          title={
            <div>
              <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">استعلام و استفاده</p>
              <h2 className="mt-1 text-base sm:text-lg font-semibold text-stone-950 dark:text-stone-100">مصرف و مانده</h2>
            </div>
          }
          bodyClassName="space-y-3 p-4 sm:p-5"
        >
          <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <Field label="کد کارت">
              <input className={inputClass} dir="ltr" value={redeemCode} onChange={(e) => setRedeemCode(e.target.value)} />
            </Field>
            <Field label={`مبلغ مصرف (${money.unitLabel})`}>
              <PersianNumberInput
                inputMode="numeric"
                className={inputClass}
                dir="ltr"
                value={redeemValue}
                onChange={(e) => setRedeemValue(e.target.value)}
              />
            </Field>
            <Button type="button" variant="outline" disabled={busy || !redeemCode.trim()} onClick={() => void check()} className="min-h-11 w-full sm:w-auto">
              مانده
            </Button>
          </div>
          <Button
            type="button"
            disabled={busy || !redeemCode.trim() || !redeemValue.trim()}
            onClick={() => void redeem()}
            className="min-h-11 w-full"
          >
            مصرف کارت
          </Button>
          {balance != null ? <p className="text-xs text-muted-foreground">ماندهٔ کارت: {money.format(balance)}</p> : null}
          <p className="text-xs leading-5 text-muted-foreground">
            کارت هدیه یک بدهی واقعی است؛ صدور آن را بستانکار و مصرف آن را بدهکار می‌کند و هرگز درآمد را دوباره ثبت
            نمی‌کند. ماندهٔ کل کارت‌ها در میز کار رشد، از دفتر کل بازسازی می‌شود.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
