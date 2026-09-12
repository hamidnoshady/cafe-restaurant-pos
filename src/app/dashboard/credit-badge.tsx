"use client";

/**
 * The small wallet-credit indicator shown in the dashboard chrome on every
 * page (desktop sidebar footer + mobile header). Deliberately compact: a coin
 * icon and the Toman balance, linking to the billing page. Polls every
 * 60 seconds and after the window regains focus so a top-up settles without a
 * reload. The billing page itself carries the full ledger/packages; this is
 * only the always-visible glance.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { WalletIcon } from "lucide-react";
import { formatToman } from "@/lib/money";
import { toPersianDigits } from "@/lib/digits";

interface WalletSnapshot {
  balanceRial: number;
}

export function CreditBadge({ compact = false }: { compact?: boolean }) {
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/billing/wallet", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { wallet?: WalletSnapshot };
      if (typeof data.wallet?.balanceRial === "number") {
        setBalance(data.wallet.balanceRial);
      }
    } catch {
      // Network/offline: leave the last value rather than flashing an error.
    }
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60_000);
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);

  const label =
    balance == null ? "…" : toPersianDigits(formatToman(balance, { withUnit: false }));

  return (
    <Link
      href="/settings/billing"
      title="اعتبار و شارژ حساب"
      aria-label={`اعتبار حساب: ${balance == null ? "نامشخص" : formatToman(balance ?? 0)} تومان`}
      className={`group inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-300/60 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 transition hover:border-amber-400 hover:bg-amber-100 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:bg-amber-500/20 ${
        compact ? "h-8 w-8 justify-center !px-0" : ""
      }`}
    >
      <WalletIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {!compact && (
        <span className="whitespace-nowrap tabular-nums">
          {label}
          <span className="mr-1 font-normal text-amber-700/80 dark:text-amber-200/70">تومان</span>
        </span>
      )}
    </Link>
  );
}
