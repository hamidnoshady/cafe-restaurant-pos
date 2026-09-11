"use client";

/**
 * Phase 15 — the platform audit log, rebuilt as a timeline instead of a
 * scroll-to-forever table.
 *
 * Every privileged cross-tenant action, newest first: who did it, to which
 * business, when, with what payload. This is the console's accountability
 * surface (exit criterion 3), so the redesign is about *scanning*, not
 * reading: day groups, per-action colors and icons, quick filters (search,
 * action family, business, date), collapsible payloads, and "load more"
 * paging over the last 500 rows the API serves. Read-only.
 */
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Archive,
  Ban,
  CircleCheck,
  Globe,
  KeyRound,
  Layers,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Store,
  Trash2,
  X,
} from "lucide-react";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import {
  api,
  errorMessage,
  ErrorBox,
  Card,
  EmptyState,
  SkeletonRows,
  Button,
  inputClass,
  selectClass,
} from "../ui";

interface AuditEntry {
  id: string;
  adminName: string | null;
  businessId: string | null;
  businessName: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  payload: unknown;
  createdAt: string;
}

type Tone = "ok" | "warn" | "bad" | "info" | "key" | "muted";

interface ActionMeta {
  label: string;
  tone: Tone;
  icon: React.ComponentType<{ className?: string }>;
}

const ACTION_META: Record<string, ActionMeta> = {
  "business.provision": { label: "ایجاد کسب‌وکار", tone: "ok", icon: Store },
  "business.active": { label: "فعال‌سازی", tone: "ok", icon: CircleCheck },
  "business.suspended": { label: "تعلیق", tone: "warn", icon: Ban },
  "business.archived": { label: "بایگانی", tone: "muted", icon: Archive },
  "business.delete": { label: "حذف قطعی", tone: "bad", icon: Trash2 },
  "business.reset": { label: "ریست کامل کسب‌وکار", tone: "bad", icon: RotateCcw },
  "business.plan": { label: "تغییر پلن", tone: "info", icon: Layers },
  "business.edit": { label: "ویرایش کسب‌وکار", tone: "info", icon: Pencil },
  "business.subdomain": { label: "تغییر نشانی (ساب‌دامنه)", tone: "info", icon: Globe },
  "business.industry_change": { label: "تغییر نوع کسب‌وکار", tone: "info", icon: SlidersHorizontal },
  "feature.override": { label: "بازنویسی پرچم ویژگی", tone: "info", icon: SlidersHorizontal },
  "impersonation.start": { label: "شروع دسترسی پشتیبانی", tone: "key", icon: KeyRound },
  "impersonation.end": { label: "پایان دسترسی پشتیبانی", tone: "key", icon: KeyRound },
  "impersonation.revoke": { label: "لغو دسترسی پشتیبانی", tone: "key", icon: KeyRound },
};

const TONE_CLS: Record<Tone, { text: string; ring: string; bg: string; dot: string }> = {
  ok: { text: "text-emerald-700 dark:text-emerald-300", ring: "border-emerald-500/30", bg: "bg-emerald-500/10", dot: "bg-emerald-400" },
  warn: { text: "text-amber-700 dark:text-amber-300", ring: "border-amber-500/30", bg: "bg-amber-500/10", dot: "bg-amber-400" },
  bad: { text: "text-red-700 dark:text-red-300", ring: "border-red-500/30", bg: "bg-red-500/10", dot: "bg-red-400" },
  info: { text: "text-sky-700 dark:text-sky-300", ring: "border-sky-500/30", bg: "bg-sky-500/10", dot: "bg-sky-400" },
  key: { text: "text-violet-700 dark:text-violet-300", ring: "border-violet-500/30", bg: "bg-violet-500/10", dot: "bg-violet-400" },
  muted: { text: "text-muted-foreground", ring: "border-border", bg: "bg-muted", dot: "bg-muted" },
};

function metaFor(action: string): ActionMeta {
  return ACTION_META[action] ?? { label: action, tone: "muted", icon: CircleCheck };
}

function fmtTime(iso: string): string {
  try {
    return toPersianDigits(
      new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)),
    );
  } catch {
    return iso;
  }
}

/** «امروز» / «دیروز» / Persian full date — the day-group heading. */
function dayLabel(ts: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (ts >= today.getTime()) return "امروز";
  if (ts >= today.getTime() - dayMs) return "دیروز";
  try {
    return toPersianDigits(new Intl.DateTimeFormat("fa-IR", { dateStyle: "full" }).format(new Date(ts)));
  } catch {
    return toPersianDigits(formatJalali(new Date(ts)));
  }
}

function relativeTime(iso: string): string {
  try {
    const diffMin = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (diffMin < 1) return "همین حالا";
    if (diffMin < 60) return `${toPersianDigits(diffMin)} دقیقه پیش`;
    const hours = Math.round(diffMin / 60);
    if (hours < 24) return `${toPersianDigits(hours)} ساعت پیش`;
    const days = Math.round(hours / 24);
    if (days < 30) return `${toPersianDigits(days)} روز پیش`;
    const months = Math.round(days / 30);
    return `${toPersianDigits(months)} ماه پیش`;
  } catch {
    return "";
  }
}

const DATE_PRESETS = [
  { days: 0, label: "همه" },
  { days: 1, label: "امروز" },
  { days: 7, label: "۷ روز" },
  { days: 30, label: "۳۰ روز" },
  { days: 90, label: "۹۰ روز" },
];

const PAGE = 40;

export default function AuditPage() {
  // `?businessId=` arrives from a business's overview page ("events of this
  // tenant"); hydrating the filter from the URL makes the two views one flow.
  return (
    <Suspense fallback={<SkeletonRows rows={8} label="در حال بارگذاری رویدادهای ممیزی" />}>
      <AuditTimeline />
    </Suspense>
  );
}

function AuditTimeline() {
  const searchParams = useSearchParams();
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [q, setQ] = useState("");
  const [action, setAction] = useState("");
  const [businessId, setBusinessId] = useState(() => searchParams.get("businessId") ?? "");
  const [preset, setPreset] = useState(0);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    // One fat page, paged client-side: the API caps at 500 and the filters
    // below (including date) slice locally, so paging never races the server.
    const { ok, data } = await api<{ entries: AuditEntry[]; error?: string }>(
      "/api/platform/audit?limit=500",
    );
    if (ok) setEntries(data.entries ?? []);
    else setError(errorMessage(data.error));
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const businesses = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries ?? []) {
      if (e.businessId && e.businessName) map.set(e.businessId, e.businessName);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1], "fa"));
  }, [entries]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries ?? []) map.set(e.action, (map.get(e.action) ?? 0) + 1);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const visible = useMemo(() => {
    const list = entries ?? [];
    const needle = q.trim().toLowerCase();
    const dayMs = 24 * 60 * 60 * 1000;
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;
    const presetTs = !fromTs && !toTs && preset > 0 ? Date.now() - preset * dayMs : null;
    return list.filter((e) => {
      if (action && e.action !== action) return false;
      if (businessId && e.businessId !== businessId) return false;
      if (needle) {
        const hay = `${metaFor(e.action).label} ${e.action} ${e.adminName ?? ""} ${e.businessName ?? ""} ${e.entityId ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      const t = new Date(e.createdAt).getTime();
      if (fromTs !== null && t < fromTs) return false;
      if (toTs !== null && t > toTs) return false;
      if (presetTs !== null && t < presetTs) return false;
      return true;
    });
  }, [entries, q, action, businessId, preset, from, to]);

  // Day groups, newest day first; entries are already time-desc.
  const groups = useMemo(() => {
    const out: { dayTs: number; items: AuditEntry[] }[] = [];
    for (const e of visible.slice(0, limit)) {
      const d = new Date(e.createdAt);
      d.setHours(0, 0, 0, 0);
      const dayTs = d.getTime();
      const last = out[out.length - 1];
      if (last && last.dayTs === dayTs) last.items.push(e);
      else out.push({ dayTs, items: [e] });
    }
    return out;
  }, [visible, limit]);

  const hasFilters = Boolean(q || action || businessId || preset || from || to);

  function clearFilters() {
    setQ("");
    setAction("");
    setBusinessId("");
    setPreset(0);
    setFrom("");
    setTo("");
    setLimit(PAGE);
  }

  function toggle(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Excel opens a BOM-prefixed UTF-8 CSV correctly even with Persian text. */
  function exportCsv() {
    const head = ["datetime", "action", "business", "admin", "entity", "payload"];
    const lines = visible.map((e) =>
      [
        new Date(e.createdAt).toISOString(),
        e.action,
        e.businessName ?? "",
        e.adminName ?? "system",
        e.entity ?? "",
        JSON.stringify(e.payload ?? {}),
      ]
        .map((cell) => `"${String(cell).replaceAll('"', '""')}"`)
        .join(","),
    );
    const blob = new Blob(["\ufeff" + [head.join(","), ...lines].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `platform-events-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">رویدادها</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            هر اقدام مدیریتی روی کسب‌وکارها — چه کسی، روی کدام کسب‌وکار، چه زمانی.
            {entries ? ` ${formatPersianNumber(entries.length)} رویداد اخیر.` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {visible.length > 0 ? (
            <Button variant="ghost" onClick={exportCsv}>
              خروجی CSV
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`ms-1 inline h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            تازه‌سازی
          </Button>
        </div>
      </div>

      <ErrorBox>{error}</ErrorBox>

      {entries === null && loading ? (
        <SkeletonRows rows={6} />
      ) : entries && entries.length === 0 ? (
        <EmptyState title="هنوز رویدادی ثبت نشده است." hint="با اولین اقدام مدیریتی، اینجا پر می‌شود." />
      ) : (
        <>
          <Card>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div className="relative">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={q}
                  onChange={(e) => {
                    setQ(e.target.value);
                    setLimit(PAGE);
                  }}
                  className={`${inputClass} ps-9`}
                  placeholder="جستجو در مدیر، کسب‌وکار یا اقدام…"
                />
              </div>
              <select
                value={action}
                onChange={(e) => {
                  setAction(e.target.value);
                  setLimit(PAGE);
                }}
                className={selectClass}
                aria-label="نوع اقدام"
              >
                <option value="">همه اقدام‌ها</option>
                {counts.map(([key, n]) => (
                  <option key={key} value={key}>
                    {metaFor(key).label} ({toPersianDigits(n)})
                  </option>
                ))}
              </select>
              <select
                value={businessId}
                onChange={(e) => {
                  setBusinessId(e.target.value);
                  setLimit(PAGE);
                }}
                className={selectClass}
                aria-label="کسب‌وکار"
              >
                <option value="">همه کسب‌وکارها</option>
                {businesses.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
              {hasFilters ? (
                <Button variant="ghost" onClick={clearFilters} className="text-xs">
                  <X className="ms-1 inline h-3.5 w-3.5" />
                  حذف فیلترها
                </Button>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">بازه زمانی:</span>
              {DATE_PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  onClick={() => {
                    setPreset(p.days);
                    setFrom("");
                    setTo("");
                    setLimit(PAGE);
                  }}
                  className={
                    preset === p.days && !from && !to
                      ? "rounded-full border border-sky-400/50 bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-700 dark:text-sky-300"
                      : "rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  }
                >
                  {p.label}
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-muted" aria-hidden />
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                از
                <JalaliDatePicker
                  className={`${inputClass} !h-8 w-[9rem] text-xs`}
                  popoverClass="absolute z-50 mt-1 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground"
                  value={from}
                  onChange={(v) => {
                    setFrom(v);
                    setPreset(0);
                    setLimit(PAGE);
                  }}
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                تا
                <JalaliDatePicker
                  className={`${inputClass} !h-8 w-[9rem] text-xs`}
                  popoverClass="absolute z-50 mt-1 w-64 rounded-xl border border-border bg-popover p-3 text-popover-foreground"
                  value={to}
                  onChange={(v) => {
                    setTo(v);
                    setPreset(0);
                    setLimit(PAGE);
                  }}
                />
              </label>
            </div>
          </Card>

          <div className="space-y-5">
            {groups.map((g) => (
              <section key={g.dayTs}>
                <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400/70" aria-hidden />
                  {dayLabel(g.dayTs)}
                  <span className="text-xs font-normal text-muted-foreground">
                    {formatPersianNumber(g.items.length)} رویداد
                  </span>
                </h2>
                <div className="overflow-hidden rounded-xl border border-border">
                  {g.items.map((e, idx) => {
                    const m = metaFor(e.action);
                    const tone = TONE_CLS[m.tone];
                    const Icon = m.icon;
                    const open = expanded.has(e.id);
                    return (
                      <div
                        key={e.id}
                        className={`flex gap-3 bg-card px-3 py-2.5 sm:px-4 ${idx > 0 ? "border-t border-border" : ""}`}
                      >
                        <span
                          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${tone.ring} ${tone.bg} ${tone.text}`}
                          aria-hidden
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                            <span className={`text-sm font-medium ${tone.text}`}>{m.label}</span>
                            {e.businessId ? (
                              <Link
                                href={`/platform/businesses/${e.businessId}`}
                                className="truncate text-sm text-sky-700 dark:text-sky-300 hover:underline"
                              >
                                {e.businessName ?? e.businessId}
                              </Link>
                            ) : e.businessName ? (
                              <span className="text-sm text-muted-foreground">{e.businessName}</span>
                            ) : (
                              <span className="text-sm text-muted-foreground">بدون کسب‌وکار</span>
                            )}
                            <span className="ms-auto flex items-center gap-2 whitespace-nowrap text-[11px] text-muted-foreground">
                              <span title={relativeTime(e.createdAt)}>{relativeTime(e.createdAt)}</span>
                              <span dir="ltr" className="tabular-nums">
                                {fmtTime(e.createdAt)}
                              </span>
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                            <span>
                              مدیر: <span className="text-muted-foreground">{e.adminName ?? "سیستم"}</span>
                            </span>
                            {e.entity ? (
                              <span>
                                موجودیت: <span className="text-muted-foreground">{e.entity}</span>
                              </span>
                            ) : null}
                            {e.payload !== null && e.payload !== undefined ? (
                              <button
                                type="button"
                                onClick={() => toggle(e.id)}
                                className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
                                  open
                                    ? "border-sky-400/40 text-sky-700 dark:text-sky-300"
                                    : "border-border text-muted-foreground hover:bg-muted hover:text-foreground"
                                }`}
                                aria-expanded={open}
                              >
                                {open ? "بستن جزئیات" : "جزئیات"}
                              </button>
                            ) : null}
                          </div>
                          {open ? (
                            <pre
                              dir="ltr"
                              className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-3 text-start text-[11px] leading-5 text-foreground"
                            >
                              {JSON.stringify(e.payload, null, 2) ?? "null"}
                            </pre>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          <div className="flex items-center justify-center gap-3 pb-2">
            {visible.length > limit ? (
              <Button variant="ghost" onClick={() => setLimit((n) => n + PAGE)}>
                نمایش بیشتر ({formatPersianNumber(Math.min(PAGE, visible.length - limit))} مورد بعدی)
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">
                {visible.length === 0
                  ? "رویدادی با این فیلترها نیست."
                  : `همه ${formatPersianNumber(visible.length)} رویدادِ منطبق نمایش داده شد.`}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
