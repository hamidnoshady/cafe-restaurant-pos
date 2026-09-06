"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * «تنظیمات و همگام‌سازی» — the CMS manager's wiring section (Phase 38,
 * issues #379 / #381; moved out of the technical connections hub when both
 * website systems became managers of «مدیریت وب‌سایت»).
 *
 * Three things, in the order an owner meets them:
 *
 *   1. **Connect.** CMS address, domain, key — tested before it is saved, and
 *      never shown again afterwards (the summary is masked; there is no field
 *      for the key in any response).
 *   2. **What goes to the site.** Two independent switches — prices, stock —
 *      and the product list where each row is marked to go (default: none).
 *   3. **The queue.** Pending / failed / stopped rows, each with «تلاش مجدد»,
 *      and «همگام‌سازی اکنون» for the impatient.
 *
 * Content — posts, product copy — is written in this manager's «محتوا» and
 * «فروشگاه» sections and by the assistant; this section is the wiring.
 */
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatJalali } from "@/lib/jalali";
import { formatRial } from "@/lib/money";
import { formatPersianNumber, toPersianDigits } from "@/lib/digits";
import { WEBSITE_ERROR_LABELS } from "@/lib/website/adapter";
import { WEBSITE_OUTBOX_KIND_LABELS, WEBSITE_OUTBOX_STATUS_LABELS } from "@/lib/website/sync";
import { EmptyState, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { api, ErrorBox, errorMessageOrRaw, Field, InfoBox, inputClass } from "@/app/dashboard/ui";

interface ConnectionSummary {
  id: string;
  adapterKey: "payload" | "mock";
  siteDomain: string;
  baseUrl: string;
  siteCurrency: string;
  status: "active" | "disabled";
  lastCheckedAt: string | null;
  lastError: string | null;
  pushPrices: boolean;
  pushStock: boolean;
  productScope: "selected" | "all";
  syncLocationId: string | null;
}

interface QueueSummary {
  pending: number;
  failed: number;
  dead: number;
  sent24h: number;
}

interface CatalogRow {
  localKind: "item" | "menu_item";
  localId: string;
  name: string;
  sku: string | null;
  priceRial: number | null;
  syncEnabled: boolean;
  remoteId: string | null;
  lastPushedAt: string | null;
  lastPushedPriceRial: number | null;
  lastPushedStock: number | null;
}

interface QueueRow {
  id: string;
  kind: keyof typeof WEBSITE_OUTBOX_KIND_LABELS;
  productName: string | null;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  nextAttemptAt: string;
  error: string | null;
  sentAt: string | null;
}

const LOCAL_KIND_LABELS = { menu_item: "منو", item: "کالا" } as const;

function describeError(code: string | undefined): string {
  if (!code) return "";
  return (WEBSITE_ERROR_LABELS as Record<string, string>)[code] ?? errorMessageOrRaw(code);
}

function statusTone(status: QueueRow["status"]): "active" | "positive" | "neutral" | "danger" {
  if (status === "sent") return "positive";
  if (status === "dead") return "danger";
  if (status === "failed") return "active";
  return "neutral";
}

export function CmsSyncSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [connection, setConnection] = useState<ConnectionSummary | null>(null);
  const [queue, setQueue] = useState<QueueSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ enabled: boolean; connection: ConnectionSummary | null; queue: QueueSummary | null }>(
      "/api/connections/website",
    );
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      setLoading(false);
      return;
    }
    setEnabled(res.data.enabled);
    setConnection(res.data.connection);
    setQueue(res.data.queue);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSkeleton label="در حال بارگذاری اتصال وب‌سایت…" />;

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {!enabled ? null : connection ? (
        <>
          <ConnectedCard connection={connection} onChange={load} />
          <SyncSettingsCard connection={connection} onChange={load} />
          <ProductsCard />
          <QueueCard summary={queue} onChange={load} />
        </>
      ) : (
        <ConnectForm onConnected={load} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

function ConnectForm({ onConnected }: { onConnected: () => Promise<void> }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [siteDomain, setSiteDomain] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [siteCurrency, setSiteCurrency] = useState<"IRT" | "IRR">("IRT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await api<{ connection: ConnectionSummary }>("/api/connections/website", {
      method: "POST",
      body: JSON.stringify({ adapterKey: "payload", baseUrl, siteDomain, apiKey, siteCurrency }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(describeError((res.data as { error?: string }).error));
      return;
    }
    setApiKey("");
    await onConnected();
  }

  return (
    <SectionCard
      title="اتصال وب‌سایت"
      description="کلید پیش از ذخیره آزمایش می‌شود؛ کلیدی که کار نکند ذخیره نمی‌شود. کلید پس از ذخیره دیگر نمایش داده نمی‌شود."
    >
      <form onSubmit={submit} className="max-w-xl">
        <ErrorBox>{error}</ErrorBox>
        <Field label="آدرس CMS" hint="مثلاً https://cms.example.com">
          <input className={inputClass} dir="ltr" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} required />
        </Field>
        <Field label="دامنهٔ سایت" hint="دامنه‌ای که سایت روی آن دیده می‌شود، بدون http">
          <input className={inputClass} dir="ltr" value={siteDomain} onChange={(e) => setSiteDomain(e.target.value)} required />
        </Field>
        <Field label="کلید API سایت" hint="از پنل CMS، با پیشوند eshobe_live_">
          <input
            className={inputClass}
            dir="ltr"
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            required
          />
        </Field>
        <Field label="واحد قیمت در سایت" hint="قیمت‌ها در این برنامه همیشه ریال‌اند؛ تبدیل به واحد سایت خودکار انجام می‌شود.">
          <select className={inputClass} value={siteCurrency} onChange={(e) => setSiteCurrency(e.target.value as "IRT" | "IRR")}>
            <option value="IRT">تومان</option>
            <option value="IRR">ریال</option>
          </select>
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? "در حال آزمایش اتصال…" : "آزمایش و ذخیره"}
        </Button>
      </form>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Connected
// ---------------------------------------------------------------------------

function ConnectedCard({ connection, onChange }: { connection: ConnectionSummary; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState<"test" | "disconnect" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function test() {
    setBusy("test");
    setError(null);
    setMessage(null);
    const res = await api<{ ok: boolean; siteName: string | null; error?: string }>("/api/connections/website/test", {
      method: "POST",
    });
    setBusy(null);
    if (!res.ok) setError(describeError((res.data as { error?: string }).error));
    else setMessage(res.data.siteName ? `اتصال برقرار است — «${res.data.siteName}»` : "اتصال برقرار است.");
    await onChange();
  }

  async function disconnect() {
    if (!window.confirm("اتصال وب‌سایت قطع شود؟ سایت و محتوایش می‌مانند؛ فقط کلید ذخیره‌شده پاک می‌شود.")) return;
    setBusy("disconnect");
    await api("/api/connections/website", { method: "DELETE" });
    setBusy(null);
    await onChange();
  }

  return (
    <SectionCard
      title="اتصال فعال"
      actions={
        <>
          <Button type="button" variant="outline" size="sm" onClick={test} disabled={busy !== null}>
            {busy === "test" ? "در حال آزمایش…" : "آزمایش اتصال"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={disconnect} disabled={busy !== null}>
            قطع اتصال
          </Button>
        </>
      }
    >
      <ErrorBox>{error}</ErrorBox>
      {message ? <InfoBox>{message}</InfoBox> : null}
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">دامنه</dt>
          <dd dir="ltr" className="text-start font-medium">{connection.siteDomain}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">وضعیت</dt>
          <dd>
            {connection.lastError ? (
              <StatusBadge tone="danger">{describeError(connection.lastError)}</StatusBadge>
            ) : (
              <StatusBadge tone="positive">متصل</StatusBadge>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">آخرین آزمایش</dt>
          <dd>{connection.lastCheckedAt ? formatJalali(connection.lastCheckedAt, { withTime: true }) : "—"}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">واحد قیمت سایت</dt>
          <dd>{connection.siteCurrency === "IRR" ? "ریال" : connection.siteCurrency === "IRT" ? "تومان" : connection.siteCurrency}</dd>
        </div>
      </dl>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Sync switches
// ---------------------------------------------------------------------------

function SyncSettingsCard({ connection, onChange }: { connection: ConnectionSummary; onChange: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    await api("/api/connections/website/settings", { method: "PATCH", body: JSON.stringify(body) });
    setBusy(false);
    await onChange();
  }

  return (
    <SectionCard
      title="چه چیزی به سایت می‌رود"
      description="یک‌طرفه: از این برنامه به سایت. سایت ویترین است؛ منبع حقیقت قیمت و موجودی همین‌جاست."
    >
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="size-4"
            checked={connection.pushPrices}
            disabled={busy}
            onChange={(e) => patch({ pushPrices: e.target.checked })}
          />
          <span>ارسال قیمت‌ها به سایت</span>
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            className="size-4"
            checked={connection.pushStock}
            disabled={busy}
            onChange={(e) => patch({ pushStock: e.target.checked })}
          />
          <span>ارسال موجودی به سایت</span>
        </label>
        <label className="flex items-center gap-3">
          <span className="text-muted-foreground">کدام محصول‌ها:</span>
          <select
            className={`${inputClass} max-w-xs`}
            value={connection.productScope}
            disabled={busy}
            onChange={(e) => patch({ productScope: e.target.value })}
          >
            <option value="selected">فقط محصول‌های علامت‌خورده</option>
            <option value="all">همهٔ محصول‌های علامت‌خورده یا قبلاً ارسال‌شده</option>
          </select>
        </label>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

function ProductsCard() {
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const res = await api<{ products: CatalogRow[] }>("/api/connections/website/products");
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      setRows([]);
      return;
    }
    setRows(res.data.products);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(row: CatalogRow, enabled: boolean) {
    setBusyId(row.localId);
    const res = await api("/api/connections/website/products", {
      method: "POST",
      body: JSON.stringify({ localKind: row.localKind, localId: row.localId, enabled }),
    });
    setBusyId(null);
    if (!res.ok) setError(errorMessageOrRaw((res.data as { error?: string }).error));
    await load();
  }

  const visible = (rows ?? []).filter((r) => !filter || r.name.includes(filter) || (r.sku ?? "").includes(filter));
  const marked = (rows ?? []).filter((r) => r.syncEnabled).length;

  return (
    <SectionCard
      title="محصول‌ها"
      description={`${toPersianDigits(String(marked))} محصول علامت‌خورده. محصولی که علامت نخورده هرگز به سایت نمی‌رود.`}
      actions={
        <input
          className={`${inputClass} h-9 w-48`}
          placeholder="جستجو…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      }
      flush
    >
      {rows === null ? (
        <LoadingSkeleton label="در حال بارگذاری محصول‌ها…" />
      ) : (
        <>
          {error ? <div className="px-4 pt-4"><ErrorBox>{error}</ErrorBox></div> : null}
          {visible.length === 0 ? (
            <div className="p-4">
              <EmptyState>محصولی برای نمایش نیست.</EmptyState>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border/80">
                    <th className="px-4 py-2 text-start font-medium">ارسال</th>
                    <th className="px-4 py-2 text-start font-medium">نام</th>
                    <th className="px-4 py-2 text-start font-medium">نوع</th>
                    <th className="px-4 py-2 text-start font-medium">قیمت (ریال)</th>
                    <th className="px-4 py-2 text-start font-medium">آخرین ارسال</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={`${row.localKind}:${row.localId}`} className="border-b border-border/60 last:border-b-0">
                      <td className="px-4 py-2">
                        <input
                          type="checkbox"
                          className="size-4"
                          checked={row.syncEnabled}
                          disabled={busyId === row.localId}
                          onChange={(e) => toggle(row, e.target.checked)}
                          aria-label={`ارسال ${row.name} به سایت`}
                        />
                      </td>
                      <td className="px-4 py-2">
                        <div className="font-medium">{row.name}</div>
                        {row.sku ? <div dir="ltr" className="text-start text-xs text-muted-foreground">{row.sku}</div> : null}
                      </td>
                      <td className="px-4 py-2 text-muted-foreground">{LOCAL_KIND_LABELS[row.localKind]}</td>
                      <td className="px-4 py-2 tabular-nums">{row.priceRial === null ? "—" : formatRial(row.priceRial, { withUnit: false })}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">
                        {row.lastPushedAt ? (
                          <>
                            <div>{formatJalali(row.lastPushedAt, { withTime: true })}</div>
                            <div>
                              {row.lastPushedPriceRial !== null ? `قیمت ${formatRial(row.lastPushedPriceRial)}` : ""}
                              {row.lastPushedStock !== null ? ` · موجودی ${formatPersianNumber(row.lastPushedStock)}` : ""}
                            </div>
                          </>
                        ) : row.syncEnabled ? (
                          <StatusBadge tone="active">در صف</StatusBadge>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

function QueueCard({ summary, onChange }: { summary: QueueSummary | null; onChange: () => Promise<void> }) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [view, setView] = useState<"open" | "sent">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await api<{ rows: QueueRow[] }>(`/api/connections/website/queue?status=${view}`);
    setRows(res.ok ? res.data.rows : []);
  }, [view]);

  useEffect(() => {
    void load();
  }, [load]);

  async function retry(id: string) {
    setBusy(id);
    await api(`/api/connections/website/queue/${id}/retry`, { method: "POST" });
    setBusy(null);
    await Promise.all([load(), onChange()]);
  }

  async function syncNow() {
    setBusy("sync");
    setSyncResult(null);
    const res = await api<{ queued: number; sent: number; failed: number }>("/api/connections/website/sync", { method: "POST" });
    setBusy(null);
    if (res.ok) {
      setSyncResult(
        `${toPersianDigits(String(res.data.queued))} در صف، ${toPersianDigits(String(res.data.sent))} ارسال شد، ${toPersianDigits(String(res.data.failed))} ناموفق.`,
      );
    }
    await Promise.all([load(), onChange()]);
  }

  return (
    <SectionCard
      title="صف ارسال"
      description={
        summary
          ? `${toPersianDigits(String(summary.pending))} در انتظار · ${toPersianDigits(String(summary.failed))} ناموفق · ${toPersianDigits(String(summary.dead))} متوقف · ${toPersianDigits(String(summary.sent24h))} ارسال در ۲۴ ساعت گذشته`
          : undefined
      }
      actions={
        <>
          <select className={`${inputClass} h-9 w-auto`} value={view} onChange={(e) => setView(e.target.value as "open" | "sent")}>
            <option value="open">باز</option>
            <option value="sent">ارسال‌شده</option>
          </select>
          <Button type="button" variant="outline" size="sm" onClick={syncNow} disabled={busy !== null}>
            {busy === "sync" ? "در حال همگام‌سازی…" : "همگام‌سازی اکنون"}
          </Button>
        </>
      }
      flush
    >
      {syncResult ? <div className="px-4 pt-4"><InfoBox>{syncResult}</InfoBox></div> : null}
      {rows === null ? (
        <LoadingSkeleton label="در حال بارگذاری صف…" />
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyState>{view === "open" ? "صف خالی است؛ همه‌چیز با سایت همگام است." : "چیزی هنوز ارسال نشده است."}</EmptyState>
        </div>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{row.productName ?? "محصول حذف‌شده"}</span>
                  <span className="text-muted-foreground">{WEBSITE_OUTBOX_KIND_LABELS[row.kind]}</span>
                  <StatusBadge tone={statusTone(row.status)}>{WEBSITE_OUTBOX_STATUS_LABELS[row.status]}</StatusBadge>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {row.status === "sent" && row.sentAt
                    ? formatJalali(row.sentAt, { withTime: true })
                    : `تلاش ${toPersianDigits(String(row.attempts))} · نوبت بعد ${formatJalali(row.nextAttemptAt, { withTime: true })}`}
                  {row.error ? <span className="ms-2 text-destructive">{describeError(row.error)}</span> : null}
                </div>
              </div>
              {row.status === "failed" || row.status === "dead" ? (
                <Button type="button" variant="outline" size="sm" onClick={() => retry(row.id)} disabled={busy !== null}>
                  تلاش مجدد
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
