"use client";

import { useMemo, useState } from "react";
import {
  PlatformDataTable,
  PlatformPageContainer,
  PlatformPageHeader,
  PlatformRefreshButton,
  PlatformStatusBadge,
  type Column,
} from "@/components/platform";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { usePlatformQuery } from "../_lib/use-platform-data";
import { fmtDateTime, fmtRelative } from "@/lib/platform-format";

interface ExceptionEvent {
  id: string;
  installationId: string;
  installationLabel: string;
  eventId: string;
  kind: "support.ticket.created" | "support.message.created" | "bug_report.created";
  aggregateId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  receivedAt: string;
}

const kindLabel: Record<ExceptionEvent["kind"], string> = {
  "support.ticket.created": "تیکت جدید",
  "support.message.created": "پیام پشتیبانی",
  "bug_report.created": "گزارش خطا",
};

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function EventDetails({ event }: { event: ExceptionEvent }) {
  const payload = event.payload;
  const title = event.kind === "bug_report.created" ? "شرح خطا" : text(payload.subject) ?? "متن پیام";
  const body = event.kind === "bug_report.created" ? text(payload.description) : text(payload.body);
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="whitespace-pre-wrap leading-7">{body ?? "—"}</p>
        {text(payload.pageUrl) ? <p className="break-all text-muted-foreground">صفحه: {text(payload.pageUrl)}</p> : null}
        <dl className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <div><dt>شناسه نصب</dt><dd className="font-mono">{event.installationId}</dd></div>
          <div><dt>شناسه پرونده</dt><dd className="font-mono">{event.aggregateId}</dd></div>
          <div><dt>زمان ایجاد</dt><dd>{fmtDateTime(event.occurredAt)}</dd></div>
          <div><dt>زمان دریافت</dt><dd>{fmtDateTime(event.receivedAt)}</dd></div>
        </dl>
      </CardContent>
    </Card>
  );
}

export default function CloudExceptionsPage() {
  const [kind, setKind] = useState("all");
  const [selected, setSelected] = useState<ExceptionEvent | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [replyStatus, setReplyStatus] = useState<string | null>(null);
  const url = useMemo(() => `/api/platform/cloud-exceptions?limit=200${kind === "all" ? "" : `&kind=${encodeURIComponent(kind)}`}`, [kind]);
  const query = usePlatformQuery<{ events: ExceptionEvent[] }>(url, [url]);
  const columns: Column<ExceptionEvent>[] = [
    { key: "kind", header: "نوع", cell: (row) => <PlatformStatusBadge tone={row.kind === "bug_report.created" ? "warning" : "info"} label={kindLabel[row.kind]} /> },
    { key: "installation", header: "نصب", cell: (row) => <div><p className="font-medium">{row.installationLabel}</p><p className="font-mono text-xs text-muted-foreground">{row.installationId}</p></div> },
    { key: "summary", header: "خلاصه", cell: (row) => <span className="line-clamp-2 max-w-md">{text(row.payload.subject) ?? text(row.payload.description) ?? text(row.payload.body) ?? "—"}</span> },
    { key: "received", header: "دریافت", align: "end", cell: (row) => <span title={fmtDateTime(row.receivedAt)}>{fmtRelative(row.receivedAt)}</span> },
  ];
  async function sendReply() {
    if (!selected || !reply.trim() || sending) return;
    setSending(true);
    setReplyStatus(null);
    try {
      const response = await fetch(`/api/platform/cloud-exceptions/${selected.id}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: reply }),
      });
      if (!response.ok) throw new Error("reply_failed");
      setReply("");
      setReplyStatus("پاسخ در صف تحویل امن به نصب محلی قرار گرفت.");
    } catch {
      setReplyStatus("ارسال پاسخ ممکن نشد. دوباره تلاش کنید.");
    } finally {
      setSending(false);
    }
  }
  return (
    <PlatformPageContainer width="wide">
      <PlatformPageHeader
        title="صندوق نصب‌های محلی"
        description="تیکت‌ها و گزارش‌های خطایی که از نصب مستقل یا سایت Hybrid با کانال استثنای امن دریافت شده‌اند."
        actions={<PlatformRefreshButton onClick={query.refetch} refreshing={query.refreshing} />}
      />
      <div className="mb-4 max-w-xs">
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger aria-label="نوع رویداد"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">همه رویدادها</SelectItem>
            <SelectItem value="support.ticket.created">تیکت جدید</SelectItem>
            <SelectItem value="support.message.created">پیام پشتیبانی</SelectItem>
            <SelectItem value="bug_report.created">گزارش خطا</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <PlatformDataTable
        columns={columns}
        rows={query.data?.events ?? null}
        rowKey={(row) => row.id}
        onRowClick={setSelected}
        emptyTitle="رویدادی دریافت نشده است"
      />
      {selected ? (
        <div className="mt-4 space-y-4">
          <EventDetails event={selected} />
          {selected.kind.startsWith("support.") ? (
            <Card>
              <CardHeader><CardTitle className="text-base">پاسخ به نصب محلی</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Textarea value={reply} onChange={(event) => setReply(event.target.value)} maxLength={5000} rows={5} placeholder="متن پاسخ پشتیبانی…" />
                <div className="flex items-center gap-3">
                  <Button onClick={sendReply} disabled={sending || !reply.trim()}>{sending ? "در حال ثبت…" : "ثبت پاسخ"}</Button>
                  {replyStatus ? <p className="text-sm text-muted-foreground">{replyStatus}</p> : null}
                </div>
              </CardContent>
            </Card>
          ) : null}
        </div>
      ) : null}
    </PlatformPageContainer>
  );
}
