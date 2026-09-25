"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PlatformDataTable, PlatformPageContainer, PlatformPageHeader, type Column } from "@/components/platform";
import { usePlatformQuery, usePlatformMutation } from "../../_lib/use-platform-data";
import { fmtDateTime } from "@/lib/platform-format";

interface Grant {
  id: string;
  businessId: string;
  businessName: string | null;
  platformAdminId: string;
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

const LABEL = { read_only: "فقط خواندنی", controlled: "محدود فنی", full: "کامل", emergency: "اضطراری" } as const;

export default function ActiveSupportSessionsPage() {
  const query = usePlatformQuery<{ grants: Grant[] }>("/api/platform/impersonation", []);
  const revoke = usePlatformMutation<{ id: string }>("", { method: "DELETE", request: ({ id }) => ({ url: `/api/platform/impersonation/${id}?action=revoke` }), successToast: "نشست لغو شد.", onSuccess: query.refetch });
  const rows = (query.data?.grants ?? []).filter((grant) => !grant.endedAt && !grant.revokedAt && new Date(grant.expiresAt).getTime() > Date.now());
  const columns: Column<Grant>[] = [
    { key: "business", header: "کسب‌وکار", cell: (g) => <Link className="text-primary hover:underline" href={`/platform/businesses/${g.businessId}/support`}>{g.businessName ?? "—"}</Link> },
    { key: "operator", header: "اپراتور", cell: (g) => `${g.operatorName ?? "—"} · ${g.operatorRole ?? "—"}` },
    { key: "mode", header: "دسترسی", cell: (g) => LABEL[g.mode] },
    { key: "reason", header: "دلیل", cell: (g) => g.reason },
    { key: "ticket", header: "تیکت", cell: (g) => g.ticketId ? `#${g.ticketId.slice(0, 8)}` : "—" },
    { key: "started", header: "شروع", cell: (g) => fmtDateTime(g.createdAt) },
    { key: "expires", header: "پایان خودکار", cell: (g) => fmtDateTime(g.expiresAt) },
    { key: "actions", header: "اقدام", cell: (g) => <Button variant="destructive" size="sm" disabled={revoke.busy} onClick={() => revoke.mutate({ id: g.id })}>لغو</Button> },
  ];
  return <PlatformPageContainer><PlatformPageHeader title="نشست‌های فعال پشتیبانی" description="دسترسی‌های زنده در همهٔ کسب‌وکارها؛ هر نشست از اینجا قابل بررسی و لغو است." /><PlatformDataTable columns={columns} rows={rows} rowKey={(row) => row.id} loading={query.loading} emptyTitle="نشست فعالی وجود ندارد" /></PlatformPageContainer>;
}
