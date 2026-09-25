"use client";

import { useEffect, useMemo, useState } from "react";
import { EyeIcon, ShieldAlertIcon, WrenchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatPersianNumber } from "@/lib/digits";

const MODE = {
  read_only: { label: "فقط خواندنی", Icon: EyeIcon },
  controlled: { label: "دسترسی محدود فنی", Icon: WrenchIcon },
  full: { label: "دسترسی تغییر", Icon: ShieldAlertIcon },
  emergency: { label: "دسترسی اضطراری", Icon: ShieldAlertIcon },
} as const;

export function SupportSessionBanner({ session }: { session: {
  businessName: string;
  operatorName: string;
  mode: keyof typeof MODE;
  expiresAt: string;
} }) {
  const [now, setNow] = useState(() => Date.now());
  const [ending, setEnding] = useState(false);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const minutes = useMemo(() => Math.max(0, Math.ceil((new Date(session.expiresAt).getTime() - now) / 60_000)), [now, session.expiresAt]);
  const meta = MODE[session.mode];

  async function endSession() {
    if (ending) return;
    setEnding(true);
    const response = await fetch("/api/support-access", { method: "DELETE" });
    const data = await response.json().catch(() => ({}));
    if (response.ok) window.location.href = data.returnTo ?? "/platform";
    else setEnding(false);
  }

  return (
    <aside className="border-b border-amber-500/30 bg-amber-50 px-3 py-2 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100" aria-live="polite">
      <div className="mx-auto flex max-w-screen-2xl flex-wrap items-center justify-between gap-2 text-xs sm:text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <meta.Icon className="size-4 shrink-0" aria-hidden="true" />
          <strong>نشست پشتیبانی · {meta.label}</strong>
          <span className="hidden text-current/75 sm:inline">اپراتور: {session.operatorName} · مشاهدهٔ {session.businessName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span>{minutes > 0 ? `${formatPersianNumber(minutes)} دقیقه باقی‌مانده` : "نشست منقضی شده است"}</span>
          <Button size="sm" variant="outline" onClick={() => void endSession()} disabled={ending}>
            {ending ? "در حال پایان…" : "پایان نشست"}
          </Button>
        </div>
      </div>
    </aside>
  );
}
