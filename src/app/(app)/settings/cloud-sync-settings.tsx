"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CloudIcon, DatabaseIcon, RefreshCwIcon, ServerIcon } from "lucide-react";
import { cardClass, SectionCardSkeleton } from "@/app/dashboard/page-chrome";
import type { ConnectionStatus, PlatformConnectionState } from "@/lib/connection-state";
import type { DeploymentProfile } from "@/lib/deployment-mode";
import { Button } from "@/components/ui/button";

interface StatusResponse extends PlatformConnectionState { profile: DeploymentProfile }
const LABEL: Record<ConnectionStatus, string> = {
  connected: "متصل", unreachable: "در دسترس نیست", unknown: "نامشخص", connecting: "در حال اتصال",
  paused: "موقتاً متوقف", not_configured: "تنظیم نشده", attention_required: "نیازمند بررسی", not_applicable: "کاربرد ندارد",
};

export function CloudSyncSettings() {
  const [state, setState] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  async function refresh() {
    setLoading(true);
    try {
      const response = await fetch("/api/connection/status", { cache: "no-store" });
      if (response.ok) setState(await response.json() as StatusResponse);
    } finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  if (!state && loading) return <SectionCardSkeleton rows={4} label="در حال بررسی وضعیت اتصال" />;
  if (!state) return <div className={`${cardClass} p-5 text-sm text-muted-foreground`}>وضعیت اتصال در دسترس نیست.</div>;
  const local = state.profile === "local";
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <StatusCard icon={ServerIcon} title="سیستم محلی" value={LABEL[state.localServer]} />
        <StatusCard icon={CloudIcon} title="حساب ابری" value={LABEL[state.cloud]} />
        <StatusCard icon={RefreshCwIcon} title="همگام‌سازی" value={LABEL[state.sync]} />
      </div>
      <section className={`${cardClass} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-foreground">{local ? "اتصال به ابر اشوبه" : "وضعیت داده‌ها"}</h3>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
              {local
                ? "پایگاه داده و پشتیبان‌گیری محلی فعال‌اند. اتصال ابری فقط پس از بررسی سازگاری، تطبیق داده‌ها، راه‌اندازی اولیه و تأیید نهایی همگام‌سازی فعال می‌شود."
                : `آخرین همگام‌سازی موفق: ${state.lastSuccessfulSyncAt ? new Date(state.lastSuccessfulSyncAt).toLocaleString("fa-IR") : "هنوز انجام نشده"}`}
            </p>
          </div>
          {local ? (
            <Button asChild><Link href="/settings/connections?tab=server_sync"><CloudIcon className="size-4" /> اتصال به ابر</Link></Button>
          ) : (
            <Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCwIcon className="size-4" /> به‌روزرسانی</Button>
          )}
        </div>
        {!local ? (
          <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-4">
            <Metric label="خروجی در انتظار" value={state.outboundPending} />
            <Metric label="ورودی در انتظار" value={state.inboundPending} />
            <Metric label="تعارض" value={state.conflicts} />
            <Metric label="نیازمند بررسی" value={state.deadLetters} />
          </dl>
        ) : null}
      </section>
      <section className={`${cardClass} p-5`}>
        <div className="flex items-center gap-2"><DatabaseIcon className="size-5 text-muted-foreground" /><h3 className="font-bold">دامنه‌های داده</h3></div>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">سفارش، حسابداری و موجودی در سایت محلی مرجع‌اند؛ مشتری و کالا مشترک‌اند؛ مسیر پشتیبان و چاپگر فقط روی این دستگاه می‌مانند.</p>
      </section>
    </div>
  );
}
function StatusCard({ icon: Icon, title, value }: { icon: typeof CloudIcon; title: string; value: string }) {
  return <div className={`${cardClass} p-4`}><Icon className="size-5 text-amber-700 dark:text-amber-300" /><p className="mt-3 text-xs text-muted-foreground">{title}</p><p className="mt-1 font-semibold">{value}</p></div>;
}
function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-lg bg-muted p-3"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-bold">{value.toLocaleString("fa-IR")}</dd></div>; }
