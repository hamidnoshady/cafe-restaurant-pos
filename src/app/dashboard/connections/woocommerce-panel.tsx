"use client";

/**
 * «فروشگاه ووکامرس» — the WooCommerce connection panel, carried over from the
 * old standalone `/dashboard/integrations` page and extended for the second
 * way a store can now connect.
 *
 * The two modes are presented as a choice up front rather than as an advanced
 * option, because they are genuinely different setups: the plugin mode asks
 * for an address and hands back one token to paste into WordPress; the REST
 * mode asks for consumer keys the owner has to mint in WP admin first and then
 * a webhook to configure by hand. Most people want the first; a store that
 * cannot install plugins needs the second.
 */
import { useCallback, useEffect, useState } from "react";
import { useFeatureLocked } from "@/components/feature-lock";
import { InfoBox, api, errorMessageOrRaw } from "../ui";

type LinkMode = "rest_api" | "plugin";

interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  linkMode: LinkMode;
  currencyUnit: "rial" | "toman";
  status: "active" | "paused" | "error";
  lastSyncAt: string | null;
  lastError: string | null;
  webhookPath: string;
  hasLinkToken: boolean;
  linkTokenSetAt: string | null;
  pluginVersion: string | null;
  pluginSiteUrl: string | null;
  lastPluginSeenAt: string | null;
  inbox: Record<string, number>;
  outbox: Record<string, number>;
}

interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  remoteId: string | null;
  error: string | null;
  createdAt: string;
}

interface OutboxJob {
  id: string;
  entityType: string;
  remoteId: string;
  status: "pending" | "processing" | "sent" | "failed" | "dead";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
}

const ACTION_LABELS: Record<string, string> = {
  "connection.created": "اتصال ایجاد شد",
  "connection.updated": "اتصال ویرایش شد",
  "connection.deleted": "اتصال حذف شد",
  "connection.test_ok": "تست اتصال موفق",
  "connection.test_failed": "تست اتصال ناموفق",
  "connection.link_token_rotated": "توکن افزونه تعویض شد",
  "plugin.handshake": "افزونهٔ وردپرس متصل شد",
  "order.imported": "سفارش وارد شد",
  "refund.imported": "برگشت وجه وارد شد",
  "products.synced": "همگام‌سازی محصولات",
  "customers.synced": "همگام‌سازی مشتریان",
  "reconciliation.run": "مغایرت‌گیری",
  "outbox.dead_lettered": "خطای دائمی ارسال",
};

const OUTBOX_TYPE_LABELS: Record<string, string> = {
  stock: "ارسال موجودی",
  price: "ارسال قیمت",
  catalogue_export: "همگام‌سازی محصولات",
  customer_export: "همگام‌سازی مشتریان",
};

const OUTBOX_STATUS_LABELS: Record<string, string> = {
  pending: "در انتظار",
  processing: "در حال انجام",
  sent: "ارسال شده",
  failed: "ناموفق",
  dead: "خطای دائمی",
};

/**
 * In plugin mode the store is reachable only through the plugin's own run, so
 * a pending queue with no recent contact means the plugin (or its cron) is
 * not running — the queue is real, it is just not being drained.
 */
const PLUGIN_STALE_MS = 15 * 60 * 1000;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fa-IR", { dateStyle: "short", timeStyle: "short" });
}

/** A secret shown exactly once. Deliberately loud: there is no second chance to read it. */
function ShowOnceSecret({ title, value, note, onDone }: { title: string; value: string; note: string; onDone: () => void }) {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
      <p className="font-semibold text-amber-900">{title}</p>
      <p className="mt-1 text-xs text-amber-800">{note}</p>
      <code dir="ltr" className="mt-2 block select-all break-all rounded-lg bg-white/70 p-2 font-mono text-amber-900">
        {value}
      </code>
      <button
        type="button"
        className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-xs text-white"
        onClick={() => {
          void navigator.clipboard.writeText(value).catch(() => undefined);
          onDone();
        }}
      >
        کپی و بستن
      </button>
    </div>
  );
}

export function WooCommercePanel() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const [outboxJobs, setOutboxJobs] = useState<OutboxJob[]>([]);
  const [outboxFor, setOutboxFor] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
    linkMode: "plugin" as LinkMode,
    consumerKey: "",
    consumerSecret: "",
    currencyUnit: "toman" as "rial" | "toman",
  });

  const load = useCallback(async () => {
    // Locked preview: /api/integrations/* answers `feature_disabled`, so asking
    // would only replace the (accurate) "no store connected yet" empty state
    // with a load error.
    if (locked) {
      setConnections([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const { ok, data } = await api<{ connections?: Connection[] }>("/api/integrations/overview");
    if (ok) setConnections(data.connections ?? []);
    else setMessage({ kind: "error", text: "بارگذاری اتصال‌ها ممکن نشد." });
    setLoading(false);
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAudit = useCallback(
    async (connectionId: string) => {
      if (auditFor === connectionId) {
        setAuditFor(null);
        setAudit([]);
        return;
      }
      setAuditFor(connectionId);
      const { data } = await api<{ entries?: AuditEntry[] }>(`/api/integrations/connections/${connectionId}/audit`);
      setAudit(data.entries ?? []);
    },
    [auditFor],
  );

  const loadOutbox = useCallback(
    async (connectionId: string) => {
      if (outboxFor === connectionId) {
        setOutboxFor(null);
        setOutboxJobs([]);
        return;
      }
      setOutboxFor(connectionId);
      const { data } = await api<{ jobs?: OutboxJob[] }>(`/api/integrations/connections/${connectionId}/outbox`);
      setOutboxJobs(data.jobs ?? []);
    },
    [outboxFor],
  );

  async function call<T extends Record<string, unknown>>(path: string, method = "POST", body?: unknown): Promise<T | null> {
    setBusy(path);
    setMessage(null);
    const { ok, data } = await api<T & { error?: string; queued?: boolean }>(path, {
      method,
      body: body ? JSON.stringify(body) : undefined,
    });
    setBusy(null);
    if (!ok) {
      setMessage({ kind: "error", text: errorMessageOrRaw(data.error) || "عملیات ناموفق بود." });
      await load();
      return null;
    }
    // "queued" is what a plugin-mode action returns: the app cannot reach the
    // store itself, so the work waits for the plugin's next run. Saying so is
    // the difference between "nothing happened" and "it is on its way".
    if (data.queued) setMessage({ kind: "ok", text: "درخواست در صف قرار گرفت و در اجرای بعدی افزونه انجام می‌شود." });
    else setMessage({ kind: "ok", text: "انجام شد." });
    await load();
    return data;
  }

  async function createConnection() {
    const data = await call<{ webhookSecret?: string; linkToken?: string | null }>(
      "/api/integrations/connections",
      "POST",
      form,
    );
    if (!data) return;
    if (data.linkToken) setLinkToken(data.linkToken);
    else if (data.webhookSecret) setWebhookSecret(data.webhookSecret);
    setForm({ ...form, name: "", baseUrl: "", consumerKey: "", consumerSecret: "" });
  }

  async function rotateToken(id: string) {
    const data = await call<{ linkToken?: string }>(`/api/integrations/connections/${id}/link-token`, "POST");
    if (data?.linkToken) setLinkToken(data.linkToken);
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-6">
      {message ? (
        <div
          className={`rounded-lg border p-3 text-sm ${
            message.kind === "ok"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 text-red-800"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {linkToken ? (
        <ShowOnceSecret
          title="توکن اتصال افزونهٔ وردپرس"
          note="این توکن فقط همین یک بار نمایش داده می‌شود. آن را در تنظیمات افزونه در وردپرس، کنار آدرس همین سامانه، وارد کنید."
          value={linkToken}
          onDone={() => setLinkToken(null)}
        />
      ) : null}

      {webhookSecret ? (
        <ShowOnceSecret
          title="کلید وب‌هوک ووکامرس"
          note="این کلید فقط همین یک بار نمایش داده می‌شود. در ووکامرس، هنگام ساخت وب‌هوک، در فیلد Secret وارد شود."
          value={webhookSecret}
          onDone={() => setWebhookSecret(null)}
        />
      ) : null}

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-1 text-base font-semibold">افزودن فروشگاه</h2>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          روش پیشنهادی «افزونهٔ وردپرس» است: فقط یک توکن می‌گیرید و آن را در وردپرس وارد می‌کنید؛ خودِ افزونه
          هر دو جهت همگام‌سازی را انجام می‌دهد و نیازی به باز بودن فروشگاه از بیرون ندارد.
        </p>

        <div className="mb-3 flex flex-wrap gap-2">
          {(
            [
              { key: "plugin" as const, label: "با افزونهٔ وردپرس (پیشنهادی)" },
              { key: "rest_api" as const, label: "با کلیدهای REST ووکامرس" },
            ]
          ).map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setForm({ ...form, linkMode: option.key })}
              className={`rounded-lg border px-3 py-1.5 text-xs ${
                form.linkMode === option.key ? "border-stone-900 bg-stone-900 text-white" : "border-stone-200"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <input
            className="rounded-md border p-2 text-sm"
            placeholder="نام فروشگاه"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="rounded-md border p-2 text-sm"
            dir="ltr"
            placeholder="https://shop.example.com"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
          {form.linkMode === "rest_api" ? (
            <>
              <input
                className="rounded-md border p-2 text-sm"
                dir="ltr"
                placeholder="Consumer Key (ck_…)"
                value={form.consumerKey}
                onChange={(e) => setForm({ ...form, consumerKey: e.target.value })}
              />
              <input
                className="rounded-md border p-2 text-sm"
                dir="ltr"
                placeholder="Consumer Secret (cs_…)"
                value={form.consumerSecret}
                onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })}
              />
            </>
          ) : null}
          <select
            className="rounded-md border p-2 text-sm"
            value={form.currencyUnit}
            onChange={(e) => setForm({ ...form, currencyUnit: e.target.value as "rial" | "toman" })}
          >
            <option value="toman">واحد قیمت فروشگاه: تومان</option>
            <option value="rial">واحد قیمت فروشگاه: ریال</option>
          </select>
          <button
            type="button"
            className="rounded-md bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            onClick={createConnection}
            disabled={busy !== null}
          >
            {form.linkMode === "plugin" ? "ساخت اتصال و توکن افزونه" : "اتصال و ذخیره"}
          </button>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">فروشگاه‌های متصل</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز فروشگاهی متصل نشده است.</p>
        ) : (
          <ul className="space-y-3">
            {connections.map((c) => {
              const queueCount = (c.outbox.pending ?? 0) + (c.outbox.failed ?? 0) + (c.outbox.processing ?? 0);
              const lastSeenAt = c.lastPluginSeenAt ? new Date(c.lastPluginSeenAt).getTime() : 0;
              // Plugin mode: the plugin is the queue manager. A pending queue
              // with no recent contact means it is not running, and the "در صف"
              // number is honest but stuck — say so out loud.
              const pluginSeenStale =
                c.linkMode === "plugin" && (lastSeenAt === 0 || Date.now() - lastSeenAt > PLUGIN_STALE_MS);
              const pluginStale = pluginSeenStale && queueCount > 0;
              return (
              <li key={c.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {c.baseUrl}
                  </span>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-700">
                    {c.linkMode === "plugin" ? "افزونهٔ وردپرس" : "کلیدهای REST"}
                  </span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      c.status === "active"
                        ? "bg-emerald-100 text-emerald-800"
                        : c.status === "error"
                          ? "bg-red-100 text-red-800"
                          : "bg-stone-200 text-stone-700"
                    }`}
                  >
                    {c.status === "active" ? "فعال" : c.status === "paused" ? "متوقف" : "خطا"}
                  </span>
                  {c.lastError ? <span className="text-xs text-red-600">{c.lastError}</span> : null}
                </div>

                {c.linkMode === "plugin" ? (
                  <div className="mt-2 space-y-1 rounded-md bg-stone-50 p-2 text-xs text-muted-foreground">
                    <div>
                      آدرس این سامانه برای افزونه: <span dir="ltr" className="select-all font-mono">{origin}</span>
                    </div>
                    <div className={pluginSeenStale ? "text-amber-700" : ""}>
                      آخرین ارتباط افزونه: {formatDateTime(c.lastPluginSeenAt)}
                      {c.pluginVersion ? ` • نسخهٔ افزونه ${c.pluginVersion}` : ""}
                    </div>
                    {!c.lastPluginSeenAt ? (
                      <div className="text-amber-700">
                        افزونه هنوز متصل نشده است. در وردپرس، آدرس بالا و توکن را وارد و «آزمایش اتصال» را بزنید.
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="mt-1 text-xs text-muted-foreground" dir="ltr">
                    {origin}
                    {c.webhookPath}
                  </div>
                )}

                {pluginStale ? (
                  <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs leading-5 text-amber-900">
                    <p className="font-semibold">این صف منتظر افزونهٔ وردپرس است.</p>
                    <p>
                      در حالت افزونه، سامانه به فروشگاه دسترسی مستقیم ندارد و خودِ افزونه صف را تخلیه می‌کند. بیش از ۱۵
                      دقیقه است افزونه با سامانه در تماس نبوده؛ اگر در وردپرس فعال است، کرون آن را بررسی کنید — کرون داخلی
                      وردپرس فقط هنگام بازدید از سایت اجرا می‌شود. برای همگام‌سازی بدون وقفه، یک کرون واقعی در هاست تنظیم
                      کنید: <code dir="ltr" className="font-mono">wp cron event run --due-now</code>
                    </p>
                  </div>
                ) : null}

                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() => call(`/api/integrations/connections/${c.id}/test`)}
                    disabled={busy !== null}
                  >
                    تست اتصال
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/products`)}
                    disabled={busy !== null}
                  >
                    همگام‌سازی محصولات
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/customers`)}
                    disabled={busy !== null}
                  >
                    همگام‌سازی مشتریان
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() => call(`/api/integrations/connections/${c.id}/sync/inventory`)}
                    disabled={busy !== null}
                  >
                    ارسال موجودی و قیمت
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() => call(`/api/integrations/connections/${c.id}/reconcile`)}
                    disabled={busy !== null}
                  >
                    مغایرت‌گیری
                  </button>
                  {c.linkMode === "plugin" ? (
                    <button
                      type="button"
                      className="rounded-md border px-2 py-1"
                      onClick={() => rotateToken(c.id)}
                      disabled={busy !== null}
                    >
                      تعویض توکن افزونه
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() =>
                      call(`/api/integrations/connections/${c.id}`, "PATCH", {
                        status: c.status === "active" ? "paused" : "active",
                      })
                    }
                    disabled={busy !== null}
                  >
                    {c.status === "active" ? "توقف" : "فعال‌سازی"}
                  </button>
                  <button
                    type="button"
                    className="rounded-md border px-2 py-1"
                    onClick={() => void loadAudit(c.id)}
                    disabled={busy !== null}
                  >
                    گزارش رویدادها
                  </button>
                  <button className="rounded-md border px-2 py-1" onClick={() => void loadOutbox(c.id)} disabled={busy !== null}>
                    کارهای در صف
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-red-200 px-2 py-1 text-red-700"
                    onClick={() => call(`/api/integrations/connections/${c.id}`, "DELETE")}
                    disabled={busy !== null}
                  >
                    حذف
                  </button>
                </div>

                <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>
                    دریافتی: {c.inbox.processed ?? 0} | خطا: {c.inbox.failed ?? 0}
                  </span>
                  <span>
                    ارسال: {c.outbox.sent ?? 0} | در صف: {(c.outbox.pending ?? 0) + (c.outbox.failed ?? 0) + (c.outbox.processing ?? 0)} | خطای دائمی:{" "}
                    {c.outbox.dead ?? 0}
                  </span>
                  <span>آخرین همگام‌سازی: {formatDateTime(c.lastSyncAt)}</span>
                </div>

                {c.linkMode === "plugin" ? (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    صف این فروشگاه توسط خودِ افزونهٔ وردپرس (هر ۵ دقیقه) تخلیه می‌شود؛ اگر «در صف» ثابت ماند، افزونه در
                    حال اجرا نیست.
                  </p>
                ) : null}

                {auditFor === c.id ? (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-stone-50 p-2 text-xs">
                    {audit.map((a) => (
                      <div key={a.id} className="flex flex-wrap justify-between gap-2 border-b border-stone-100 py-1">
                        <span>{ACTION_LABELS[a.action] ?? a.action}</span>
                        <span className="text-muted-foreground">{a.remoteId ?? a.entityType ?? ""}</span>
                        <span className="text-muted-foreground">{formatDateTime(a.createdAt)}</span>
                        {a.error ? <span className="text-red-600">{a.error}</span> : null}
                      </div>
                    ))}
                    {audit.length === 0 ? <p>رویدادی ثبت نشده است.</p> : null}
                  </div>
                ) : null}

                {outboxFor === c.id ? (
                  <div className="mt-2 max-h-56 overflow-y-auto rounded-md bg-stone-50 p-2 text-xs">
                    {outboxJobs.length === 0 ? (
                      <p>صف خالی است.</p>
                    ) : (
                      <ul className="space-y-1">
                        {outboxJobs.map((job) => (
                          <li
                            key={job.id}
                            className="flex flex-wrap items-center justify-between gap-2 border-b border-stone-100 py-1"
                          >
                            <span>
                              {OUTBOX_TYPE_LABELS[job.entityType] ?? job.entityType}
                              {job.entityType !== "catalogue_export" && job.entityType !== "customer_export" ? (
                                <span className="text-muted-foreground" dir="ltr">
                                  {" "}
                                  #{job.remoteId}
                                </span>
                              ) : null}
                            </span>
                            <span className="flex items-center gap-2">
                              <span
                                className={
                                  job.status === "dead"
                                    ? "text-red-600"
                                    : job.status === "failed"
                                      ? "text-amber-700"
                                      : job.status === "sent"
                                        ? "text-emerald-700"
                                        : ""
                                }
                              >
                                {OUTBOX_STATUS_LABELS[job.status] ?? job.status}
                                {job.attempts > 0 ? ` (${job.attempts} تلاش)` : ""}
                              </span>
                              <span className="text-muted-foreground">{formatDateTime(job.createdAt)}</span>
                            </span>
                            {job.lastError ? (
                              <span className="w-full text-red-600" dir="ltr">
                                {job.lastError}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="rounded-xl border bg-card p-4 text-sm">
        <h2 className="mb-2 text-base font-semibold">نصب افزونهٔ وردپرس</h2>
        <ol className="list-inside list-decimal space-y-1 text-xs leading-6 text-muted-foreground">
          <li>افزونهٔ «POS Accounting Connector» را در وردپرس نصب و فعال کنید.</li>
          <li>
            در «ووکامرس ← اتصال حسابداری»، آدرس <span dir="ltr" className="font-mono">{origin}</span> و توکنی که
            اینجا ساخته‌اید را وارد کنید.
          </li>
          <li>«آزمایش اتصال» را بزنید؛ پس از موفقیت، همگام‌سازی خودکار هر پنج دقیقه اجرا می‌شود.</li>
        </ol>
        <InfoBox>
          افزونه هیچ‌گاه به پایگاه‌دادهٔ این سامانه وصل نمی‌شود؛ همهٔ ارتباط‌ها امضاشده (HMAC-SHA256) و دارای
          مهر زمانی و شمارهٔ یک‌بارمصرف است.
        </InfoBox>
        <InfoBox>
          کرون داخلی وردپرس فقط هنگام بازدید از سایت اجرا می‌شود؛ در فروشگاه کم‌تردد، همگام‌سازی تا مراجعهٔ بعدی به تعویق
          می‌افتد. برای اجرای دقیق هر ۵ دقیقه، یک کرون واقعی در هاست تنظیم کنید:{" "}
          <code dir="ltr" className="font-mono">wp cron event run --due-now</code> (یا بازدید دوره‌ای از
          wp-cron.php).
        </InfoBox>
      </section>
    </div>
  );
}
