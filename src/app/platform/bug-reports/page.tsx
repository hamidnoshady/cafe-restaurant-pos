"use client";

/**
 * The platform-wide triage inbox for reports filed from the tenant dashboard,
 * rebuilt on the shared console kit with real server-side pagination and
 * filtering (task sections 6 + 26). The list never downloads screenshots — they
 * are multi-megabyte data URLs — so the detail drawer loads one on demand when
 * an operator opens a report. Filters live in the URL so a scoped view survives
 * a refresh and can be shared. Read-only: reports are evidence, not editable.
 */
import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import {
  BugIcon,
  Clock3Icon,
  ExternalLinkIcon,
  ImageIcon,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PlatformPageHeader,
  PlatformPageContainer,
  PlatformStat,
  PlatformDataTable,
  PlatformFilterBar,
  PlatformSearch,
  PlatformRefreshButton,
  PlatformPagination,
  PlatformStatusBadge,
  PlatformDetailDrawer,
  PlatformDetailSection,
  PlatformDetailRow,
  type StatusTone,
  type Column,
} from "@/components/platform";
import { usePlatformQuery } from "../_lib/use-platform-data";
import { useUrlFilters, useDebouncedValue } from "../_lib/use-url-filters";
import { fmtDateTime, fmtRelative } from "@/lib/platform-format";
import { formatPersianNumber } from "@/lib/digits";
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

interface ListResponse {
  reports: BugReport[];
  statusCounts?: Record<string, number>;
  meta?: { total: number; page: number; pageSize: number };
}

const STATUS_META: Record<string, { label: string; tone: StatusTone }> = {
  new: { label: "جدید", tone: "warning" },
  in_progress: { label: "در حال بررسی", tone: "info" },
  resolved: { label: "رفع‌شده", tone: "success" },
  closed: { label: "بسته‌شده", tone: "muted" },
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, tone: "neutral" as StatusTone };
}

const PAGE_SIZE = 40;

const DEFAULTS = {
  search: "",
  status: "",
  page: "1",
};

function BugReportsInner() {
  const { values, set, reset, isFiltered } = useUrlFilters(DEFAULTS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(values.search, 350);

  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("q", debouncedSearch);
    if (values.status) params.set("status", values.status);
    params.set("page", values.page || "1");
    params.set("pageSize", String(PAGE_SIZE));
    return `/api/platform/bug-reports?${params.toString()}`;
  }, [debouncedSearch, values.status, values.page]);

  const query = usePlatformQuery<ListResponse>(url, [url]);
  const reports = query.data?.reports ?? null;
  const meta = query.data?.meta;
  const counts = query.data?.statusCounts ?? {};
  const page = Number(values.page) || 1;

  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);

  const columns: Column<BugReport>[] = [
    {
      key: "business",
      header: "کسب‌وکار",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{r.businessName}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="truncate">{r.userName ?? "کاربر حذف‌شده"}</span>
            {r.userRole ? <span>({roleLabel(r.userRole)})</span> : null}
            {r.locationName ? <span className="truncate">• {r.locationName}</span> : null}
          </p>
        </div>
      ),
    },
    {
      key: "description",
      header: "شرح",
      hideOnMobile: true,
      cell: (r) => (
        <span className="line-clamp-2 max-w-md text-sm leading-6 text-muted-foreground">
          {r.description}
        </span>
      ),
    },
    {
      key: "screenshot",
      header: "",
      align: "center",
      hideOnMobile: true,
      cell: (r) =>
        r.hasScreenshot ? (
          <ImageIcon className="mx-auto size-4 text-muted-foreground" aria-label="تصویر دارد" />
        ) : null,
    },
    {
      key: "status",
      header: "وضعیت",
      cell: (r) => {
        const m = statusMeta(r.status);
        return <PlatformStatusBadge tone={m.tone} label={m.label} />;
      },
    },
    {
      key: "createdAt",
      header: "زمان",
      align: "end",
      cell: (r) => (
        <span className="whitespace-nowrap text-muted-foreground" title={fmtDateTime(r.createdAt)}>
          {fmtRelative(r.createdAt)}
        </span>
      ),
    },
  ];

  return (
    <PlatformPageContainer width="wide">
      <PlatformPageHeader
        title="گزارش‌های خطا"
        description="مشکلاتی که کاربران از داخل برنامهٔ خود برای تیم پشتیبانی فرستاده‌اند."
        actions={<PlatformRefreshButton onClick={query.refetch} refreshing={query.refreshing} />}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <PlatformStat label="کل گزارش‌ها" value={formatPersianNumber(total)} icon={<BugIcon className="size-4" />} />
        <PlatformStat
          label="جدید"
          value={formatPersianNumber(counts.new ?? 0)}
          tone={counts.new ? "warning" : "neutral"}
          icon={<Clock3Icon className="size-4" />}
        />
        <PlatformStat label="در حال بررسی" value={formatPersianNumber(counts.in_progress ?? 0)} tone="info" />
        <PlatformStat label="رفع‌شده" value={formatPersianNumber(counts.resolved ?? 0)} tone="success" />
      </div>

      <PlatformFilterBar onReset={reset} isFiltered={isFiltered} resultCount={meta?.total}>
        <PlatformSearch
          value={values.search}
          onChange={(v) => set({ search: v, page: "1" })}
          placeholder="جست‌وجو در کسب‌وکار، کاربر و متن گزارش…"
        />
        <Select
          value={values.status || "__all__"}
          onValueChange={(v) => set({ status: v === "__all__" ? "" : v, page: "1" })}
        >
          <SelectTrigger className="w-auto min-w-[9rem]">
            <SelectValue placeholder="همهٔ وضعیت‌ها" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">همهٔ وضعیت‌ها</SelectItem>
            {Object.entries(STATUS_META).map(([value, m]) => (
              <SelectItem key={value} value={value}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PlatformFilterBar>

      <PlatformDataTable
        columns={columns}
        rows={reports}
        rowKey={(r) => r.id}
        loading={query.loading}
        error={query.errorText}
        errorStatus={query.errorStatus}
        onRetry={query.refetch}
        isFiltered={isFiltered}
        onResetFilters={reset}
        onRowClick={(r) => setSelectedId(r.id)}
        emptyTitle="هنوز گزارشی ثبت نشده است."
        emptyDescription="گزارش‌های کاربران در این بخش نمایش داده می‌شوند."
      />

      {meta ? (
        <PlatformPagination
          page={page}
          pageSize={PAGE_SIZE}
          total={meta.total}
          onPageChange={(p) => set({ page: String(p) })}
        />
      ) : null}

      <BugReportDrawer id={selectedId} onClose={() => setSelectedId(null)} />
    </PlatformPageContainer>
  );
}

function BugReportDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const query = usePlatformQuery<{ report: BugReportDetail }>(
    id ? `/api/platform/bug-reports/${id}` : null,
    [id],
  );
  const report = query.data?.report ?? null;

  return (
    <PlatformDetailDrawer
      open={Boolean(id)}
      onOpenChange={(v) => !v && onClose()}
      title={report?.businessName ?? "جزئیات گزارش"}
      description={report ? fmtDateTime(report.createdAt) : undefined}
    >
      {query.loading ? (
        <p className="text-sm text-muted-foreground">در حال بارگذاری اطلاعات…</p>
      ) : report ? (
        <>
          <PlatformDetailSection title="جزئیات">
            <PlatformDetailRow label="وضعیت">
              <PlatformStatusBadge tone={statusMeta(report.status).tone} label={statusMeta(report.status).label} />
            </PlatformDetailRow>
            <PlatformDetailRow label="کسب‌وکار">
              <Link
                href={`/platform/businesses/${report.businessId}`}
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                {report.businessName}
                <ExternalLinkIcon className="size-3.5" />
              </Link>
            </PlatformDetailRow>
            <PlatformDetailRow label="گزارش‌دهنده">
              {report.userName ?? "کاربر حذف‌شده"}
              {report.userRole ? (
                <span className="text-muted-foreground"> — {roleLabel(report.userRole)}</span>
              ) : null}
            </PlatformDetailRow>
            {report.locationName ? (
              <PlatformDetailRow label="شعبه">{report.locationName}</PlatformDetailRow>
            ) : null}
            {report.viewport ? (
              <PlatformDetailRow label="اندازهٔ صفحه">
                <span dir="ltr">{report.viewport}</span>
              </PlatformDetailRow>
            ) : null}
          </PlatformDetailSection>

          <PlatformDetailSection title="شرح مشکل">
            <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm leading-7 text-foreground">
              {report.description}
            </p>
          </PlatformDetailSection>

          {report.pageUrl ? (
            <PlatformDetailSection title="صفحهٔ محل بروز مشکل">
              <code className="block break-all rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" dir="ltr">
                {report.pageUrl}
              </code>
            </PlatformDetailSection>
          ) : null}

          {report.screenshot ? (
            <PlatformDetailSection title="تصویر هنگام ثبت گزارش">
              <a
                href={report.screenshot}
                download={`bug-report-${report.id}.jpg`}
                className="group block overflow-hidden rounded-lg border border-border bg-muted/40"
              >
                { }
                <img
                  src={report.screenshot}
                  alt="تصویر صفحه هنگام گزارش"
                  className="max-h-[28rem] w-full object-contain transition group-hover:opacity-90"
                />
                <span className="flex items-center justify-center gap-1.5 border-t border-border px-3 py-2 text-xs text-primary">
                  <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
                  باز کردن تصویر
                </span>
              </a>
            </PlatformDetailSection>
          ) : report.hasScreenshot ? (
            <p className="text-xs text-muted-foreground">تصویر این گزارش قابل بارگذاری نیست.</p>
          ) : null}

          {report.userAgent ? (
            <PlatformDetailSection title="مرورگر">
              <code className="block break-all rounded-lg border border-border bg-muted/40 p-3 text-[11px] leading-5 text-muted-foreground" dir="ltr">
                {report.userAgent}
              </code>
            </PlatformDetailSection>
          ) : null}
        </>
      ) : query.errorText ? (
        <p className="text-sm text-red-600 dark:text-red-400">{query.errorText}</p>
      ) : null}
    </PlatformDetailDrawer>
  );
}

export default function BugReportsPage() {
  return (
    <Suspense fallback={null}>
      <BugReportsInner />
    </Suspense>
  );
}
