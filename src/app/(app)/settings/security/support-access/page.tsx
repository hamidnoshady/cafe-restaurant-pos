"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, Td, Th } from "@/app/dashboard/data-table";
import { EmptyState, LoadingSkeleton, PageHeader, PageShell, SectionCard } from "@/app/dashboard/page-chrome";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits } from "@/lib/digits";

interface Grant {
  id: string;
  operatorName: string | null;
  operatorRole: string | null;
  mode: "read_only" | "controlled" | "full" | "emergency";
  reason: string;
  ticketId: string | null;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  revokedAt: string | null;
}

const MODE = { read_only: "فقط خواندنی", controlled: "محدود فنی", full: "کامل", emergency: "اضطراری" } as const;
const date = (value: string | null) => value ? toPersianDigits(formatJalali(value, { withMonthName: true, withTime: true })) : "—";

export default function TenantSupportAccessPage() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState("");
  const [policy, setPolicy] = useState("standard");
  const load = useCallback(async () => {
    const response = await fetch("/api/support-access");
    const data = await response.json();
    if (response.ok) { setGrants(data.grants); setPolicy(data.policy ?? "standard"); } else setError("خواندن تاریخچهٔ دسترسی پشتیبانی ممکن نشد.");
  }, []);
  useEffect(() => { void load(); }, [load]);
  const active = (grant: Grant) => !grant.endedAt && !grant.revokedAt && new Date(grant.expiresAt).getTime() > Date.now();

  async function revoke(id: string) {
    const response = await fetch(`/api/support-access?grantId=${encodeURIComponent(id)}`, { method: "DELETE" });
    if (response.ok) void load(); else setError("نشست پیش‌تر پایان یافته یا دیگر در دسترس نیست.");
  }

  return (
    <PageShell>
      <PageHeader title="دسترسی پشتیبانی" description="نشست‌های پشتیبانی کسب‌وکار شفاف، موقت و قابل لغو هستند." />
      {error ? <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      <SectionCard>
        <label className="block max-w-md text-sm font-medium">سیاست دسترسی پشتیبانی
          <select className="mt-2 h-10 w-full rounded-lg border border-border bg-background px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={policy} onChange={async (event) => {
            const next = event.target.value;
            const response = await fetch("/api/support-access", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: next }) });
            if (response.ok) setPolicy(next); else setError("ذخیرهٔ سیاست دسترسی ممکن نشد.");
          }}>
            <option value="standard">استاندارد — مشاهده با اعلان</option>
            <option value="approval_required">تأیید برای دسترسی تغییردهنده</option>
            <option value="strict">تأیید برای همهٔ نشست‌ها</option>
            <option value="disabled">غیرفعال</option>
          </select>
        </label>
        <p className="mt-2 text-xs text-muted-foreground">تغییر سیاست، نشست‌های جدید را کنترل می‌کند؛ «غیرفعال» نشست‌های فعال را نیز در درخواست بعدی بی‌اعتبار می‌کند.</p>
      </SectionCard>
      <SectionCard>
        {grants === null ? <LoadingSkeleton rows={5} label="در حال خواندن نشست‌های پشتیبانی" /> : grants.length === 0 ? (
          <EmptyState title="نشست پشتیبانی ثبت نشده است">در صورت شروع دسترسی، جزئیات آن در این صفحه نمایش داده می‌شود.</EmptyState>
        ) : (
          <DataTable caption="تاریخچهٔ نشست‌های پشتیبانی">
            <thead><tr><Th>وضعیت</Th><Th>اپراتور</Th><Th>دسترسی</Th><Th>دلیل</Th><Th>شروع</Th><Th>پایان</Th><Th>اقدام</Th></tr></thead>
            <tbody>{grants.map((grant) => <tr key={grant.id}><Td>{active(grant) ? "فعال" : grant.revokedAt ? "لغوشده" : grant.endedAt ? "پایان‌یافته" : "منقضی"}</Td><Td>{grant.operatorName ?? "اپراتور پلتفرم"}</Td><Td>{MODE[grant.mode]}</Td><Td>{grant.reason}</Td><Td>{date(grant.createdAt)}</Td><Td>{date(grant.endedAt)}</Td><Td>{active(grant) ? <Button size="sm" variant="destructive" onClick={() => void revoke(grant.id)}>پایان دسترسی</Button> : "—"}</Td></tr>)}</tbody>
          </DataTable>
        )}
      </SectionCard>
    </PageShell>
  );
}
