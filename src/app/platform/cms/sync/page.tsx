"use client";

/**
 * «سایت‌ساز ← همگام‌سازی» — content in and out, and the log of every run.
 *
 * The order on screen is the order an operator works in: pick a site, pull its
 * content (which downloads as a JSON file — the snapshot is the operator's
 * artefact, and this deployment deliberately keeps no copy of another product's
 * content), then push a snapshot back.
 *
 * A push is a **dry run first**, always. The plan («۴ به‌روزرسانی، ۱ ساخت») is shown
 * and the apply button only appears after it — a count that arrives after the write
 * is not a decision. `force` is a separate, explicit tick, because a snapshot taken
 * from another site names that site's media and categories.
 */
import { useCallback, useEffect, useState } from "react";
import { Download, PlayCircle, RefreshCw, Upload } from "lucide-react";

import { formatPersianNumber } from "@/lib/digits";
import {
  SYNC_KIND_LABELS,
  type MirroredCmsSite,
  type SyncRunRow,
} from "@/lib/cms/platform-control";
import type { CmsImportResult, CmsSnapshot } from "@/lib/cms/platform-client";
import {
  api,
  Button,
  Card,
  EmptyState,
  ErrorBox,
  Field,
  fmtDate,
  InfoBox,
  selectClass,
  SkeletonRows,
  useCan,
} from "../../ui";
import {
  cmsErrorText,
  SNAPSHOT_COLLECTION_LABELS,
  SYNC_STATUS_LABELS,
  syncStatusTone,
} from "../text";

const COLLECTIONS = Object.keys(SNAPSHOT_COLLECTION_LABELS);

export default function CmsSyncPage() {
  const can = useCan();
  const manage = can("cms.manage");
  const [sites, setSites] = useState<MirroredCmsSite[]>([]);
  const [runs, setRuns] = useState<SyncRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<null | string>(null);
  const [error, setError] = useState<null | string>(null);
  const [notice, setNotice] = useState<null | string>(null);

  const [siteId, setSiteId] = useState("");
  const [selected, setSelected] = useState<string[]>(COLLECTIONS);
  const [snapshot, setSnapshot] = useState<CmsSnapshot | null>(null);
  const [plan, setPlan] = useState<CmsImportResult | null>(null);
  const [force, setForce] = useState(false);

  const load = useCallback(async () => {
    const [sitesRes, runsRes] = await Promise.all([
      api<{ error?: string; sites?: MirroredCmsSite[] }>("/api/platform/cms/sites"),
      api<{ runs?: SyncRunRow[] }>("/api/platform/cms/runs?limit=40"),
    ]);
    if (!sitesRes.ok) setError(cmsErrorText(sitesRes.data.error));
    setSites(sitesRes.data.sites ?? []);
    setRuns(runsRes.data.runs ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(name: string) {
    setSelected((current) =>
      current.includes(name) ? current.filter((item) => item !== name) : [...current, name],
    );
  }

  async function run(kind: string, extra: Record<string, unknown> = {}) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    const { ok, data } = await api<{
      error?: string;
      result?: { error?: string; ok: boolean; result?: CmsImportResult; snapshot?: CmsSnapshot };
      runs?: SyncRunRow[];
    }>("/api/platform/cms/sync", {
      body: JSON.stringify({ collections: selected, kind, siteId, ...extra }),
      method: "POST",
    });
    if (data.runs) setRuns(data.runs);
    if (!ok || !data.result?.ok) {
      setError(cmsErrorText(data.result?.error ?? data.error));
      setBusy(null);
      return { ok: false as const };
    }
    setBusy(null);
    return { ok: true as const, result: data.result };
  }

  async function pull() {
    const answer = await run("pull");
    if (!answer.ok) return;
    const taken = answer.result.snapshot ?? null;
    setSnapshot(taken);
    setPlan(null);
    setNotice(
      taken
        ? `تصویر محتوا گرفته شد: ${Object.entries(taken.counts)
            .map(([name, count]) => `${SNAPSHOT_COLLECTION_LABELS[name] ?? name} ${formatPersianNumber(count)}`)
            .join("، ")}`
        : "تصویر محتوا خالی بود.",
    );
  }

  async function dryRun() {
    if (!snapshot) return;
    const answer = await run("push", { dryRun: true, force, snapshot });
    if (!answer.ok) return;
    setPlan(answer.result.result ?? null);
  }

  async function apply() {
    if (!snapshot) return;
    const answer = await run("push", { dryRun: false, force, snapshot });
    if (!answer.ok) return;
    setPlan(answer.result.result ?? null);
    const summary = answer.result.result?.summary;
    setNotice(
      summary
        ? `اعمال شد: ${formatPersianNumber(summary.updated)} به‌روزرسانی، ${formatPersianNumber(summary.created)} ساخت، ${formatPersianNumber(summary.skipped)} رد‌شده.`
        : "اعمال شد.",
    );
  }

  function download() {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.download = `${snapshot.site.domain}-snapshot.json`;
    anchor.href = url;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function upload(file: File) {
    try {
      const parsed = JSON.parse(await file.text()) as CmsSnapshot;
      if (!parsed?.documents) throw new Error("no documents");
      setSnapshot(parsed);
      setPlan(null);
      setNotice(`تصویر «${parsed.site?.domain ?? "?"}» بارگذاری شد.`);
    } catch {
      setError("این فایل یک تصویر محتوای معتبر نیست.");
    }
  }

  if (loading) return <SkeletonRows label="در حال خواندن وضعیت همگام‌سازی" rows={6} />;

  return (
    <div className="space-y-4">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card title="همگام‌سازی سراسری">
        <div className="flex flex-wrap gap-2">
          <Button disabled={!manage || busy !== null} onClick={() => void run("mirror")} variant="ghost">
            <RefreshCw className="size-4" />
            {busy === "mirror" ? "در حال به‌روزرسانی…" : "به‌روزرسانی آینهٔ سایت‌ها"}
          </Button>
          <Button disabled={!manage || busy !== null} onClick={() => void run("events")} variant="ghost">
            <PlayCircle className="size-4" />
            {busy === "events" ? "در حال دریافت…" : "دریافت رویدادها و ارسال به پایش"}
          </Button>
        </div>
        <p className="mt-3 text-xs leading-6 text-white/35">
          هر دو روی زمان‌بندی سرور هم اجرا می‌شوند؛ این دکمه‌ها همان کار را بی‌درنگ انجام می‌دهند.
          دریافت رویدادها از نشانگر (cursor) ادامه می‌دهد، پس فشردن دوباره‌اش چیزی را دو بار
          نمی‌فرستد.
        </p>
      </Card>

      <Card title="محتوای یک سایت">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="سایت">
            <select
              className={selectClass}
              onChange={(event) => {
                setSiteId(event.target.value);
                setSnapshot(null);
                setPlan(null);
              }}
              value={siteId}
            >
              <option value="">— انتخاب کنید —</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.domain} — {site.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="بارگذاری تصویر از فایل">
            <input
              accept="application/json"
              className="h-10 w-full text-xs text-white/60"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
              type="file"
            />
          </Field>
        </div>

        <fieldset className="mt-3">
          <legend className="mb-2 text-xs text-white/45">مجموعه‌ها</legend>
          <div className="flex flex-wrap gap-2">
            {COLLECTIONS.map((name) => (
              <label
                className={
                  selected.includes(name)
                    ? "cursor-pointer rounded-lg border border-sky-400/40 bg-sky-500/10 px-2.5 py-1 text-xs text-sky-200"
                    : "cursor-pointer rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/50"
                }
                key={name}
              >
                <input
                  checked={selected.includes(name)}
                  className="me-1 align-middle"
                  onChange={() => toggle(name)}
                  type="checkbox"
                />
                {SNAPSHOT_COLLECTION_LABELS[name]}
              </label>
            ))}
          </div>
          <p className="mt-2 text-xs text-white/35">
            رسانه‌ها در تصویر نیستند: فایل‌ها در فضای ذخیره‌سازی ابری‌اند و یک سند JSON نمی‌تواند
            آن‌ها را حمل کند.
          </p>
        </fieldset>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button disabled={!manage || !siteId || busy !== null} onClick={pull}>
            <Download className="size-4" />
            {busy === "pull" ? "در حال دریافت…" : "دریافت محتوا"}
          </Button>
          {snapshot ? (
            <>
              <Button onClick={download} variant="ghost">
                ذخیرهٔ فایل تصویر
              </Button>
              <Button disabled={!manage || !siteId || busy !== null} onClick={dryRun} variant="ghost">
                <Upload className="size-4" />
                {busy === "push" ? "در حال بررسی…" : "بررسی آزمایشی ارسال"}
              </Button>
              <label className="flex items-center gap-2 text-xs text-white/50">
                <input
                  checked={force}
                  className="size-4"
                  onChange={(event) => setForce(event.target.checked)}
                  type="checkbox"
                />
                اجازهٔ ارسال تصویرِ سایتِ دیگر
              </label>
            </>
          ) : null}
        </div>

        {snapshot ? (
          <p className="mt-3 text-xs text-white/40">
            تصویر از «{snapshot.site?.domain}» در {fmtDate(snapshot.generatedAt)} — زبان‌ها:{" "}
            {(snapshot.locales ?? []).join("، ")}
            {snapshot.truncated?.length ? " (ناقص: از سقف پیمایش گذشته)" : ""}
          </p>
        ) : null}

        {plan ? (
          <div className="mt-4 rounded-xl border border-white/10 bg-black/20 p-3">
            <p className="text-sm">
              {plan.dryRun ? "نتیجهٔ بررسی آزمایشی" : "نتیجهٔ اعمال"}:{" "}
              <span className="text-emerald-300">
                {formatPersianNumber(plan.summary.updated)} به‌روزرسانی
              </span>
              {" · "}
              <span className="text-sky-300">{formatPersianNumber(plan.summary.created)} ساخت</span>
              {" · "}
              <span className="text-white/50">
                {formatPersianNumber(plan.summary.skipped)} رد‌شده
              </span>
            </p>
            {plan.errors.length ? (
              <ul className="mt-2 space-y-1 text-xs text-amber-300/90">
                {plan.errors.slice(0, 10).map((row, index) => (
                  <li key={`${row.collection}-${row.key}-${index}`}>
                    {SNAPSHOT_COLLECTION_LABELS[row.collection] ?? row.collection} / {row.key ?? "—"}{" "}
                    ({row.locale}): {row.message}
                  </li>
                ))}
              </ul>
            ) : null}
            {plan.dryRun && manage ? (
              <div className="mt-3">
                <Button disabled={busy !== null} onClick={apply}>
                  اعمال همین برنامه
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </Card>

      <Card title="تاریخچهٔ همگام‌سازی">
        {runs.length === 0 ? (
          <EmptyState hint="هنوز همگام‌سازی‌ای انجام نشده است." title="تاریخچه خالی است" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-white/40">
                <tr>
                  <th className="pb-2 text-start font-normal">نوع</th>
                  <th className="pb-2 text-start font-normal">آغازگر</th>
                  <th className="pb-2 text-start font-normal">وضعیت</th>
                  <th className="pb-2 text-start font-normal">مورد</th>
                  <th className="pb-2 text-start font-normal">مدت</th>
                  <th className="pb-2 text-start font-normal">زمان</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((row) => (
                  <tr className="border-t border-white/5" key={row.id}>
                    <td className="py-2 text-white/70">
                      {SYNC_KIND_LABELS[row.kind]}
                      {row.dryRun ? <span className="ms-1 text-xs text-white/35">(آزمایشی)</span> : null}
                    </td>
                    <td className="py-2 text-white/50">
                      {row.trigger === "scheduled" ? "زمان‌بندی" : "دستی"}
                    </td>
                    <td className={`py-2 ${syncStatusTone(row.status)}`}>
                      {SYNC_STATUS_LABELS[row.status]}
                      {row.error ? (
                        <span className="ms-2 text-xs">{cmsErrorText(row.error)}</span>
                      ) : null}
                    </td>
                    <td className="py-2 tabular-nums text-white/60">
                      {formatPersianNumber(row.items)}
                    </td>
                    <td className="py-2 tabular-nums text-white/40">
                      {formatPersianNumber(row.durationMs)}‏ms
                    </td>
                    <td className="py-2 text-xs text-white/40">{fmtDate(row.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
