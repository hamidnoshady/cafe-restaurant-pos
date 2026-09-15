"use client";

/**
 * The platform-wide inbox for reports submitted from the tenant dashboard.
 *
 * The list intentionally does not download screenshots. They are stored as
 * data URLs and can be several megabytes, so the detail request loads one only
 * after an operator selects a report.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BugIcon,
  Clock3Icon,
  ExternalLinkIcon,
  ImageIcon,
  MapPinIcon,
  MonitorSmartphoneIcon,
  RefreshCwIcon,
  SearchIcon,
  StoreIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
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
import { roleLabel } from "@/lib/role-labels";

interface BugReport {
  id: string;
  businessId: string;
  businessName: string;
  locationId: string | null;
  locationName: string | null;
  userId: string | null;
  userName: string | null;
  userRole: string | null;
  description: string;
  pageUrl: string | null;
  viewport: string | null;
  hasScreenshot: boolean;
  status: string;
  createdAt: string;
}

interface BugReportDetail extends BugReport {
  screenshot: string | null;
  userAgent: string | null;
}

const STATUS_LABELS: Record<string, string> = {
  new: "جدید",
  in_progress: "در حال بررسی",
  resolved: "رفع‌شده",
  closed: "بسته‌شده",
};

const STATUS_STYLES: Record<string, string> = {
  new: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  in_progress: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  resolved: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  closed: "border-border bg-muted text-muted-foreground",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function ReportStatus({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        STATUS_STYLES[status] ?? "border-border bg-muted text-muted-foreground"
      }`}
    >
      {statusLabel(status)}
    </span>
  );
}

function isToday(iso: string): boolean {
  const date = new Date(iso);
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

export default function BugReportsPage() {
  const [reports, setReports] = useState<BugReport[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BugReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ reports?: BugReport[]; error?: string }>(
      "/api/platform/bug-reports?limit=500",
    );
    if (ok) {
      setReports(data.reports ?? []);
      setError(null);
    } else {
      setError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase();
    return (reports ?? []).filter((report) => {
      if (status && report.status !== status) return false;
      if (!needle) return true;
      return [
        report.businessName,
        report.locationName,
        report.userName,
        report.description,
        report.pageUrl,
      ]
        .filter(Boolean)
        .join(" ")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [q, reports, status]);

  const stats = useMemo(() => {
    const all = reports ?? [];
    return {
      total: all.length,
      new: all.filter((report) => report.status === "new").length,
      screenshots: all.filter((report) => report.hasScreenshot).length,
      today: all.filter((report) => isToday(report.createdAt)).length,
    };
  }, [reports]);

  const selectReport = useCallback(async (id: string) => {
    setSelectedId(id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const { ok, data } = await api<{ report?: BugReportDetail; error?: string }>(
      `/api/platform/bug-reports/${id}`,
    );
    setDetailLoading(false);
    if (ok && data.report) setDetail(data.report);
    else setDetailError(data.error ?? "خطای غیرمنتظره. دوباره تلاش کنید.");
  }, []);

  const selectedSummary = visible.find((report) => report.id === selectedId) ?? null;

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-rose-500/15 text-rose-700 dark:text-rose-300">
            <BugIcon className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 className="text-xl font-bold">گزارش‌های خطا</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              مشکلاتی که کاربران از داخل برنامهٔ خود برای تیم پشتیبانی فرستاده‌اند.
            </p>
          </div>
        </div>
        <Button onClick={() => void load()} className="gap-2">
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          تازه‌سازی
        </Button>
      </div>

      <ErrorBox>{error}</ErrorBox>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="کل گزارش‌ها" value={formatPersianNumber(stats.total)} icon={<BugIcon className="size-4" />} />
        <StatCard
          label="جدید"
          value={formatPersianNumber(stats.new)}
          tone={stats.new ? "warn" : "neutral"}
          icon={<Clock3Icon className="size-4" />}
        />
        <StatCard label="همراه تصویر" value={formatPersianNumber(stats.screenshots)} icon={<ImageIcon className="size-4" />} />
        <StatCard label="امروز" value={formatPersianNumber(stats.today)} tone="ok" />
      </div>

      <Card>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-center">
          <div className="relative min-w-0">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="جست‌وجو در کسب‌وکار، کاربر و متن گزارش…"
              className={`${inputClass} ps-9`}
            />
          </div>
          <select value={status} onChange={(event) => setStatus(event.target.value)} className={selectClass} aria-label="وضعیت گزارش">
            <option value="">همهٔ وضعیت‌ها</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <span className="text-xs text-muted-foreground sm:text-end">
            {reports ? `${toPersianDigits(visible.length)} گزارش` : "در حال بارگذاری…"}
          </span>
        </div>
      </Card>

      {reports === null ? (
        <div className="mt-4">
          <SkeletonRows rows={6} label="در حال بارگذاری گزارش‌های خطا" />
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            title={reports.length === 0 ? "هنوز گزارشی ثبت نشده است." : "گزارشی با این فیلترها پیدا نشد."}
            hint={reports.length === 0 ? "گزارش‌های کاربران در این بخش نمایش داده می‌شوند." : "عبارت جست‌وجو یا وضعیت را تغییر دهید."}
          />
        </div>
      ) : (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)]">
          <div className="space-y-2">
            {visible.map((report) => (
              <button
                key={report.id}
                type="button"
                aria-pressed={selectedId === report.id}
                onClick={() => void selectReport(report.id)}
                className={`block w-full rounded-xl border p-4 text-start transition-colors ${
                  selectedId === report.id
                    ? "border-sky-400/50 bg-sky-500/10"
                    : "border-border bg-card hover:border-border hover:bg-muted"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-foreground">{report.businessName}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{report.userName ?? "کاربر حذف‌شده"}</span>
                      {report.userRole ? <span>({roleLabel(report.userRole)})</span> : null}
                      {report.locationName ? <span>• {report.locationName}</span> : null}
                    </p>
                  </div>
                  <ReportStatus status={report.status} />
                </div>
                <p className="mt-3 line-clamp-2 text-sm leading-6 text-foreground">{report.description}</p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{fmtDate(report.createdAt)}</span>
                  {report.hasScreenshot ? (
                    <span className="inline-flex items-center gap-1 text-sky-700/70 dark:text-sky-300/70">
                      <ImageIcon className="size-3" aria-hidden="true" />
                      تصویر دارد
                    </span>
                  ) : null}
                  {report.pageUrl ? <span className="max-w-[18rem] truncate" dir="ltr">{report.pageUrl}</span> : null}
                </div>
              </button>
            ))}
          </div>

          <BugReportDetails
            summary={selectedSummary}
            detail={detail}
            loading={detailLoading}
            error={detailError}
            onClose={() => {
              setSelectedId(null);
              setDetail(null);
              setDetailError(null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function BugReportDetails({
  summary,
  detail,
  loading,
  error,
  onClose,
}: {
  summary: BugReport | null;
  detail: BugReportDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  if (!summary) {
    return (
      <Card>
        <div className="flex min-h-56 flex-col items-center justify-center text-center text-muted-foreground">
          <BugIcon className="mb-3 size-8" aria-hidden="true" />
          <p className="text-sm">یک گزارش را برای مشاهدهٔ جزئیات انتخاب کنید.</p>
        </div>
      </Card>
    );
  }

  const report = detail ?? summary;
  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3 border-b border-border pb-4">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">جزئیات گزارش</p>
          <p className="mt-1 truncate font-semibold text-foreground">{report.businessName}</p>
          <code className="mt-1 block truncate text-[10px] text-muted-foreground" dir="ltr">{report.id}</code>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="بستن جزئیات"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <ReportStatus status={report.status} />
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-xs text-muted-foreground">
            <Clock3Icon className="size-3" aria-hidden="true" />
            {fmtDate(report.createdAt)}
          </span>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <DetailItem icon={<StoreIcon className="size-3.5" />} label="کسب‌وکار">
            <a href={`/platform/businesses/${report.businessId}`} className="text-sky-700 dark:text-sky-300 hover:underline">
              {report.businessName}
            </a>
          </DetailItem>
          <DetailItem icon={<UserRoundIcon className="size-3.5" />} label="گزارش‌دهنده">
            {report.userName ?? "کاربر حذف‌شده"}
            {report.userRole ? <span className="text-muted-foreground"> — {roleLabel(report.userRole)}</span> : null}
          </DetailItem>
          {report.locationName ? (
            <DetailItem icon={<MapPinIcon className="size-3.5" />} label="شعبه">
              {report.locationName}
            </DetailItem>
          ) : null}
          <DetailItem icon={<MonitorSmartphoneIcon className="size-3.5" />} label="اندازهٔ صفحه">
            <span dir="ltr">{report.viewport ?? "—"}</span>
          </DetailItem>
        </dl>

        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">شرح مشکل</p>
          <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted p-3 text-sm leading-7 text-foreground">
            {report.description}
          </p>
        </div>

        {loading ? <p className="text-xs text-muted-foreground">در حال بارگذاری اطلاعات تکمیلی…</p> : null}
        <ErrorBox>{error}</ErrorBox>

        {detail?.screenshot ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">تصویر هنگام ثبت گزارش</p>
            <a href={detail.screenshot} download={`bug-report-${detail.id}.jpg`} className="group block overflow-hidden rounded-lg border border-border bg-muted">
              <img src={detail.screenshot} alt="تصویر صفحه هنگام گزارش" className="max-h-[28rem] w-full object-contain transition group-hover:opacity-90" />
              <span className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
                <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                باز کردن تصویر
              </span>
            </a>
          </div>
        ) : summary.hasScreenshot && !loading && !error ? (
          <p className="text-xs text-muted-foreground">تصویر این گزارش قابل بارگذاری نیست.</p>
        ) : null}

        {report.pageUrl ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">صفحهٔ محل بروز مشکل</p>
            <code className="block break-all rounded-lg border border-border bg-muted p-3 text-xs text-muted-foreground" dir="ltr">
              {report.pageUrl}
            </code>
          </div>
        ) : null}

        {detail?.userAgent ? (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">مرورگر</p>
            <code className="block break-all rounded-lg border border-border bg-muted p-3 text-[11px] leading-5 text-muted-foreground" dir="ltr">
              {detail.userAgent}
            </code>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function DetailItem({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className="mt-1 truncate text-foreground">{children}</dd>
    </div>
  );
}
