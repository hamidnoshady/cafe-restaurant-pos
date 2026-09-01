"use client";

/**
 * The super-admin support desk (migration 0130) — every business's support
 * tickets in one console.
 *
 * The list intentionally does not download attachments: they are stored as
 * data URLs and can be sizable, so the detail request loads them only after
 * an operator selects a ticket. Operators can reply, re-prioritise,
 * re-categorise, reassign and move tickets through their lifecycle; every
 * write is audited server-side.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  Clock3Icon,
  InboxIcon,
  LifeBuoyIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  StoreIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABELS,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABELS,
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
} from "@/lib/support-tickets";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  SkeletonRows,
  StatCard,
  fmtDate,
  inputClass,
  selectClass,
} from "../ui";

interface SupportTicket {
  id: string;
  businessId: string;
  businessName: string;
  locationId: string | null;
  locationName: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  subject: string;
  category: string;
  priority: string;
  status: string;
  assignedAdminId: string | null;
  assignedAdminName: string | null;
  messageCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

interface SupportMessage {
  id: string;
  ticketId: string;
  authorType: "member" | "admin";
  userId: string | null;
  userName: string | null;
  adminId: string | null;
  adminName: string | null;
  body: string;
  attachment: string | null;
  createdAt: string;
}

interface SupportTicketDetail extends SupportTicket {
  messages: SupportMessage[];
}

interface TicketStats {
  total: number;
  open: number;
  inProgress: number;
  waitingCustomer: number;
  resolved: number;
  closed: number;
  urgentOpen: number;
  unassignedOpen: number;
}

const STATUS_STYLES: Record<string, string> = {
  open: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  in_progress: "border-sky-500/30 bg-sky-500/10 text-sky-300",
  waiting_customer: "border-violet-500/30 bg-violet-500/10 text-violet-300",
  resolved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  closed: "border-white/15 bg-white/5 text-white/50",
};

const PRIORITY_STYLES: Record<string, string> = {
  low: "border-white/15 bg-white/5 text-white/50",
  normal: "border-white/15 bg-white/5 text-white/65",
  high: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  urgent: "border-red-500/40 bg-red-500/10 text-red-300",
};

/** A pill whose colour comes from the wire value but whose text is the Persian label. */
function Chip({
  wireValue,
  label,
  styles,
}: {
  wireValue: string;
  label: string;
  styles: Record<string, string>;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        styles[wireValue] ?? "border-white/15 bg-white/5 text-white/60"
      }`}
    >
      {label}
    </span>
  );
}

export default function PlatformSupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const [assignableAdmins, setAssignableAdmins] = useState<{ id: string; fullName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [category, setCategory] = useState("");
  const [assignedToMe, setAssignedToMe] = useState(false);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SupportTicketDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "500" });
    if (status) params.set("status", status);
    if (priority) params.set("priority", priority);
    if (category) params.set("category", category);
    if (assignedToMe) params.set("assignedToMe", "true");
    const { ok, data } = await api<{ tickets?: SupportTicket[]; stats?: TicketStats; assignableAdmins?: { id: string; fullName: string }[]; error?: string }>(
      `/api/platform/support/tickets?${params.toString()}`,
    );
    if (ok) {
      setTickets(data.tickets ?? []);
      setStats(data.stats ?? null);
      setAssignableAdmins(data.assignableAdmins ?? []);
      setError(null);
    } else {
      setError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
    }
  }, [status, priority, category, assignedToMe]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (tickets ?? []).filter((ticket) => {
      if (!needle) return true;
      return [
        ticket.businessName,
        ticket.locationName,
        ticket.userName,
        ticket.subject,
        ticket.assignedAdminName,
        ticket.lastMessagePreview,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [q, tickets]);

  const selectTicket = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const { ok, data } = await api<{ ticket?: SupportTicketDetail; error?: string }>(
      `/api/platform/support/tickets/${id}`,
    );
    setDetailLoading(false);
    if (ok && data.ticket) setDetail(data.ticket);
    else setDetailError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
  }, []);

  const selectedSummary = visible.find((ticket) => ticket.id === selectedId) ?? null;

  return (
    <div className="mx-auto w-full max-w-7xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-teal-500/15 text-teal-300">
            <LifeBuoyIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">تیکت‌های پشتیبانی</h1>
            <p className="mt-1 text-sm text-white/40">
              درخواست‌های پشتیبانی همهٔ کسب‌وکارها؛ پاسخ‌دهی، اولویت‌بندی و ارجاع به همکاران.
            </p>
          </div>
        </div>
        <Button onClick={() => void load()} className="gap-2">
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          تازه‌سازی
        </Button>
      </div>

      <ErrorBox>{error}</ErrorBox>

      {stats ? (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard label="در انتظار پاسخ" value={toPersianDigits(stats.open + stats.inProgress)} tone="warn" icon={<Clock3Icon className="size-4" />} />
          <StatCard
            label="در انتظار کاربر"
            value={toPersianDigits(stats.waitingCustomer)}
            tone={stats.waitingCustomer ? "neutral" : "neutral"}
            icon={<UserRoundIcon className="size-4" />}
          />
          <StatCard
            label="فوریِ باز"
            value={toPersianDigits(stats.urgentOpen)}
            tone={stats.urgentOpen ? "bad" : "neutral"}
            icon={<AlertTriangleIcon className="size-4" />}
          />
          <StatCard
            label="بدون پاسخ‌دهنده"
            value={toPersianDigits(stats.unassignedOpen)}
            tone={stats.unassignedOpen ? "warn" : "ok"}
            icon={<InboxIcon className="size-4" />}
          />
        </div>
      ) : null}

      <Card>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_10rem_9rem_10rem_auto] lg:items-center">
          <div className="relative min-w-0">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-white/30"
            />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="جست‌وجو در کسب‌وکار، کاربر، موضوع و پیام‌ها…"
              className={`${inputClass} ps-9`}
            />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className={selectClass} aria-label="وضعیت تیکت">
            <option value="">همهٔ وضعیت‌ها</option>
            {TICKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TICKET_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
          <select value={priority} onChange={(event) => setPriority(event.target.value)} className={selectClass} aria-label="اولویت تیکت">
            <option value="">همهٔ اولویت‌ها</option>
            {TICKET_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TICKET_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
          <select value={category} onChange={(event) => setCategory(event.target.value)} className={selectClass} aria-label="دستهٔ تیکت">
            <option value="">همهٔ دسته‌ها</option>
            {TICKET_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {TICKET_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-white/55">
            <input
              type="checkbox"
              checked={assignedToMe}
              onChange={(event) => setAssignedToMe(event.target.checked)}
              className="size-4 accent-sky-500"
            />
            فقطِ من
          </label>
        </div>
      </Card>

      {tickets === null ? (
        <div className="mt-4">
          <SkeletonRows rows={6} label="در حال بارگذاری تیکت‌ها" />
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={tickets.length === 0 ? "تیکتی ثبت نشده است." : "تیکتی با این فیلترها پیدا نشد."}
            hint={tickets.length === 0 ? "درخواست‌های کاربران از بخش «پشتیبانی» برنامهٔ کسب‌وکارها اینجا می‌آیند." : "فیلترها یا عبارت جست‌وجو را تغییر دهید."}
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.05fr)_minmax(22rem,0.95fr)]">
          <div className="space-y-2">
            {visible.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                aria-pressed={selectedId === ticket.id}
                onClick={() => void selectTicket(ticket.id)}
                className={`block w-full rounded-xl border p-4 text-start transition-colors ${
                  selectedId === ticket.id
                    ? "border-sky-400/50 bg-sky-500/10"
                    : "border-white/10 bg-white/3 hover:border-white/20 hover:bg-white/5"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-white/90">{ticket.subject}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-white/45">
                      <span className="inline-flex items-center gap-1">
                        <StoreIcon className="size-3" aria-hidden="true" />
                        {ticket.businessName}
                      </span>
                      <span>•</span>
                      <span>{ticket.userName ?? "کاربر حذف‌شده"}</span>
                      {ticket.locationName ? <span>• {ticket.locationName}</span> : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                    <Chip wireValue={ticket.priority} label={TICKET_PRIORITY_LABELS[ticket.priority as keyof typeof TICKET_PRIORITY_LABELS] ?? ticket.priority} styles={PRIORITY_STYLES} />
                    <Chip wireValue={ticket.status} label={TICKET_STATUS_LABELS[ticket.status as keyof typeof TICKET_STATUS_LABELS] ?? ticket.status} styles={STATUS_STYLES} />
                  </div>
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-white/70">
                  {ticket.lastMessagePreview ?? "بدون پیام"}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/35">
                  <span>{fmtDate(ticket.updatedAt)}</span>
                  <span>{toPersianDigits(ticket.messageCount)} پیام</span>
                  {ticket.assignedAdminName ? <span>• پاسخ‌دهنده: {ticket.assignedAdminName}</span> : null}
                </div>
              </button>
            ))}
          </div>

          <SupportTicketPanel
            summary={selectedSummary}
            detail={detail}
            loading={detailLoading}
            error={detailError}
            assignableAdmins={assignableAdmins}
            onClose={() => {
              setSelectedId(null);
              setDetail(null);
              setDetailError(null);
            }}
            onChanged={(ticket) => {
              setDetail(ticket);
              void load();
            }}
          />
        </div>
      )}
    </div>
  );
}

function SupportTicketPanel({
  summary,
  detail,
  loading,
  error,
  assignableAdmins,
  onClose,
  onChanged,
}: {
  summary: SupportTicket | null;
  detail: SupportTicketDetail | null;
  loading: boolean;
  error: string | null;
  assignableAdmins: { id: string; fullName: string }[];
  onClose: () => void;
  onChanged: (ticket: SupportTicketDetail) => void;
}) {
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setReply("");
    setActionError(null);
  }, [summary?.id]);

  if (!summary) {
    return (
      <Card>
        <div className="flex min-h-56 flex-col items-center justify-center text-center text-white/35">
          <LifeBuoyIcon className="mb-3 size-8" aria-hidden="true" />
          <p className="text-sm">یک تیکت را برای مشاهدهٔ گفت‌وگو و پاسخ انتخاب کنید.</p>
        </div>
      </Card>
    );
  }

  const ticket = detail ?? summary;

  async function patch(fields: Record<string, unknown>) {
    setActionError(null);
    const { ok, data } = await api<{ ticket?: SupportTicketDetail; error?: string }>(
      `/api/platform/support/tickets/${summary!.id}`,
      { method: "PATCH", body: JSON.stringify(fields) },
    );
    if (ok && data.ticket) onChanged(data.ticket);
    else setActionError(data.error ?? "خطای غیرمنتظره.");
  }

  async function sendReply() {
    const text = reply.trim();
    if (!text) return;
    setSending(true);
    setActionError(null);
    const { ok, data } = await api<{ message?: SupportMessage; error?: string }>(
      `/api/platform/support/tickets/${summary!.id}/messages`,
      { method: "POST", body: JSON.stringify({ body: text }) },
    );
    setSending(false);
    if (ok && data.message) {
      setReply("");
      const { ok: okDetail, data: detailData } = await api<{ ticket?: SupportTicketDetail; error?: string }>(
        `/api/platform/support/tickets/${summary!.id}`,
      );
      if (okDetail && detailData.ticket) onChanged(detailData.ticket);
    } else {
      setActionError(data.error ?? "خطای غیرمنتظره.");
    }
  }

  const statusValue = ticket.status as keyof typeof TICKET_STATUS_LABELS;
  const priorityValue = ticket.priority as keyof typeof TICKET_PRIORITY_LABELS;
  const categoryValue = ticket.category as keyof typeof TICKET_CATEGORY_LABELS;

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div className="min-w-0">
          <p className="text-xs text-white/40">جزئیات تیکت</p>
          <p className="mt-1 truncate font-semibold text-white/90">{ticket.subject}</p>
          <code className="mt-1 block truncate text-[10px] text-white/25" dir="ltr">{ticket.id}</code>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="بستن جزئیات"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-white/45 transition hover:bg-white/5 hover:text-white"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Chip wireValue={ticket.status} label={TICKET_STATUS_LABELS[statusValue] ?? ticket.status} styles={STATUS_STYLES} />
        <Chip wireValue={ticket.priority} label={TICKET_PRIORITY_LABELS[priorityValue] ?? ticket.priority} styles={PRIORITY_STYLES} />
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-0.5 text-xs text-white/50">
          <Clock3Icon className="size-3" aria-hidden="true" />
          {fmtDate(ticket.createdAt)}
        </span>
        {ticket.closedAt ? (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-0.5 text-xs text-white/50">
            <CheckCircle2Icon className="size-3" aria-hidden="true" />
            بسته در {fmtDate(ticket.closedAt)}
          </span>
        ) : null}
      </div>

      <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="flex items-center gap-1.5 text-xs text-white/40">
            <StoreIcon className="size-3.5" aria-hidden="true" />
            کسب‌وکار
          </dt>
          <dd className="mt-1 truncate text-white/75">
            <a href={`/platform/businesses/${ticket.businessId}`} className="text-sky-300 hover:underline">
              {ticket.businessName}
            </a>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="flex items-center gap-1.5 text-xs text-white/40">
            <UserRoundIcon className="size-3.5" aria-hidden="true" />
            کاربر
          </dt>
          <dd className="mt-1 truncate text-white/75">{ticket.userName ?? "کاربر حذف‌شده"}</dd>
        </div>
      </dl>

      {/* Conversation */}
      <div className="mb-4 max-h-[24rem] space-y-3 overflow-y-auto pe-1">
        {(detail?.messages ?? []).map((message) => (
          <div
            key={message.id}
            className={`max-w-[92%] rounded-xl border p-3 ${
              message.authorType === "admin"
                ? "ms-auto border-sky-500/25 bg-sky-500/10"
                : "border-white/10 bg-white/4"
            }`}
          >
            <p className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-white/40">
              <span className="font-medium text-white/65">
                {message.authorType === "admin" ? (message.adminName ?? "تیم پشتیبانی") : (message.userName ?? "کاربر")}
              </span>
              <span>{fmtDate(message.createdAt)}</span>
              {message.authorType === "admin" ? <span className="text-sky-300/70">پاسخ سکو</span> : null}
            </p>
            <p className="whitespace-pre-wrap text-sm leading-6 text-white/80">{message.body}</p>
            {message.attachment ? (
              <a
                href={message.attachment}
                download={`ticket-${ticket.id}-${message.id}.jpg`}
                className="mt-2 block overflow-hidden rounded-lg border border-white/10 bg-black/20"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={message.attachment} alt="پیوست تیکت" className="max-h-44 w-full object-contain" />
              </a>
            ) : null}
          </div>
        ))}
        {!detail && loading ? <p className="text-xs text-white/40">در حال بارگذاری گفت‌وگو…</p> : null}
        {detail && detail.messages.length === 0 ? (
          <p className="text-xs text-white/40">پیامی در این تیکت نیست.</p>
        ) : null}
      </div>

      <ErrorBox>{error}</ErrorBox>
      {actionError ? <ErrorBox>{actionError}</ErrorBox> : null}

      {/* Lifecycle controls */}
      <div className="mb-4 grid gap-2 border-t border-white/10 pt-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[11px] text-white/40">وضعیت</span>
          <select
            value={ticket.status}
            onChange={(event) => void patch({ status: event.target.value })}
            className={selectClass}
            aria-label="تغییر وضعیت"
          >
            {TICKET_STATUSES.map((value) => (
              <option key={value} value={value}>
                {TICKET_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-white/40">اولویت</span>
          <select
            value={ticket.priority}
            onChange={(event) => void patch({ priority: event.target.value })}
            className={selectClass}
            aria-label="تغییر اولویت"
          >
            {TICKET_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {TICKET_PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-white/40">دسته</span>
          <select
            value={ticket.category}
            onChange={(event) => void patch({ category: event.target.value })}
            className={selectClass}
            aria-label="تغییر دسته"
          >
            {TICKET_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {TICKET_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] text-white/40">پاسخ‌دهنده</span>
          <select
            value={ticket.assignedAdminId ?? ""}
            onChange={(event) => void patch({ assignedAdminId: event.target.value || null })}
            className={selectClass}
            aria-label="تغییر پاسخ‌دهنده"
          >
            <option value="">بدون پاسخ‌دهنده</option>
            {assignableAdmins.map((admin) => (
              <option key={admin.id} value={admin.id}>
                {admin.fullName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Reply box */}
      <div className="space-y-2">
        <textarea
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          placeholder="پاسخ تیم پشتیبانی…"
          rows={3}
          className={`${inputClass} w-full resize-y`}
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-[11px] text-white/35">
            پاسخ شما تیکت را به «در انتظار پاسخ شما» برمی‌گرداند.
          </p>
          <Button onClick={() => void sendReply()} disabled={sending || !reply.trim()} className="gap-2">
            <SendIcon className="size-4" aria-hidden="true" />
            {sending ? "در حال ارسال…" : "ارسال پاسخ"}
          </Button>
        </div>
      </div>
    </Card>
  );
}
