"use client";

import { useCallback, useEffect, useState } from "react";
import { useFeatureLocked } from "@/components/feature-lock";

interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  currencyUnit: "rial" | "toman";
  status: "active" | "paused" | "error";
  lastSyncAt: string | null;
  lastError: string | null;
  webhookPath: string;
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

const ACTION_LABELS: Record<string, string> = {
  "connection.created": "اتصال ایجاد شد",
  "connection.updated": "اتصال ویرایش شد",
  "connection.deleted": "اتصال حذف شد",
  "connection.test_ok": "تست اتصال موفق",
  "connection.test_failed": "تست اتصال ناموفق",
  "order.imported": "سفارش وارد شد",
  "refund.imported": "برگشت وجه وارد شد",
  "products.synced": "همگام‌سازی محصولات",
  "customers.synced": "همگام‌سازی مشتریان",
  "reconciliation.run": "مغایرت‌گیری",
  "outbox.dead_lettered": "خطای دائمی ارسال",
};

export function IntegrationsManager() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditFor, setAuditFor] = useState<string | null>(null);
  const locked = useFeatureLocked();

  const [form, setForm] = useState({
    name: "",
    baseUrl: "",
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
    try {
      const res = await fetch("/api/integrations/overview");
      if (!res.ok) throw new Error();
      const data = await res.json();
      setConnections(data.connections ?? []);
    } catch {
      setMessage({ kind: "error", text: "بارگذاری اتصال‌ها ممکن نشد." });
    } finally {
      setLoading(false);
    }
  }, [locked]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAudit = useCallback(async (connectionId: string) => {
    if (auditFor === connectionId) {
      setAuditFor(null);
      setAudit([]);
      return;
    }
    setAuditFor(connectionId);
    const res = await fetch(`/api/integrations/connections/${connectionId}/audit`);
    const data = await res.json();
    setAudit(data.entries ?? []);
  }, [auditFor]);

  async function call(path: string, method = "POST", body?: unknown) {
    setBusy(path);
    setMessage(null);
    try {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed");
      return data;
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
      return null;
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function createConnection() {
    const data = await call("/api/integrations/connections", "POST", form);
    if (data?.webhookSecret) {
      setNewSecret(data.webhookSecret);
      setForm({ name: "", baseUrl: "", consumerKey: "", consumerSecret: "", currencyUnit: "toman" });
    }
  }

  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <div className="space-y-6">
      {message && (
        <div className={`rounded-lg border p-3 text-sm ${message.kind === "ok" ? "border-emerald-300 bg-emerald-50 text-emerald-800" : "border-red-300 bg-red-50 text-red-800"}`}>
          {message.text}
        </div>
      )}

      {newSecret && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">این کلید وب‌هوک فقط یک‌بار نمایش داده می‌شود.</p>
          <p className="mt-1 break-all font-mono text-amber-800">{newSecret}</p>
          <button
            className="mt-2 rounded-md bg-amber-600 px-3 py-1 text-xs text-white"
            onClick={() => {
              void navigator.clipboard.writeText(newSecret);
              setNewSecret(null);
            }}
          >
            کپی و بستن
          </button>
        </div>
      )}

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">افزودن فروشگاه ووکامرس</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <input className="rounded-md border p-2 text-sm" placeholder="نام فروشگاه" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="rounded-md border p-2 text-sm" dir="ltr" placeholder="https://shop.example.com" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
          <input className="rounded-md border p-2 text-sm" dir="ltr" placeholder="Consumer Key (ck_…)" value={form.consumerKey} onChange={(e) => setForm({ ...form, consumerKey: e.target.value })} />
          <input className="rounded-md border p-2 text-sm" dir="ltr" placeholder="Consumer Secret (cs_…)" value={form.consumerSecret} onChange={(e) => setForm({ ...form, consumerSecret: e.target.value })} />
          <select className="rounded-md border p-2 text-sm" value={form.currencyUnit} onChange={(e) => setForm({ ...form, currencyUnit: e.target.value as "rial" | "toman" })}>
            <option value="toman">واحد قیمت: تومان</option>
            <option value="rial">واحد قیمت: ریال</option>
          </select>
          <button className="rounded-md bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50" onClick={createConnection} disabled={busy !== null}>
            اتصال و ذخیره
          </button>
        </div>
      </section>

      <section className="rounded-xl border bg-card p-4">
        <h2 className="mb-3 text-base font-semibold">اتصال‌ها</h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز فروشگاهی متصل نشده است.</p>
        ) : (
          <ul className="space-y-3">
            {connections.map((c) => (
              <li key={c.id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  <span className="text-xs text-muted-foreground" dir="ltr">{c.baseUrl}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${c.status === "active" ? "bg-emerald-100 text-emerald-800" : c.status === "error" ? "bg-red-100 text-red-800" : "bg-stone-200 text-stone-700"}`}>
                    {c.status === "active" ? "فعال" : c.status === "paused" ? "متوقف" : "خطا"}
                  </span>
                  {c.lastError && <span className="text-xs text-red-600">{c.lastError}</span>}
                </div>
                <div className="mt-1 text-xs text-muted-foreground" dir="ltr">
                  {origin}{c.webhookPath}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs">
                  <button className="rounded-md border px-2 py-1" onClick={() => call(`/api/integrations/connections/${c.id}/test`)} disabled={busy !== null}>تست اتصال</button>
                  <button className="rounded-md border px-2 py-1" onClick={() => call(`/api/integrations/connections/${c.id}/sync/products`)} disabled={busy !== null}>همگام‌سازی محصولات</button>
                  <button className="rounded-md border px-2 py-1" onClick={() => call(`/api/integrations/connections/${c.id}/sync/customers`)} disabled={busy !== null}>همگام‌سازی مشتریان</button>
                  <button className="rounded-md border px-2 py-1" onClick={() => call(`/api/integrations/connections/${c.id}/sync/inventory`)} disabled={busy !== null}>ارسال موجودی و قیمت</button>
                  <button className="rounded-md border px-2 py-1" onClick={() => call(`/api/integrations/connections/${c.id}/reconcile`)} disabled={busy !== null}>مغایرت‌گیری</button>
                  <button className="rounded-md border px-2 py-1" onClick={() => call(`/api/integrations/connections/${c.id}`, "PATCH", { status: c.status === "active" ? "paused" : "active" })} disabled={busy !== null}>
                    {c.status === "active" ? "توقف" : "فعال‌سازی"}
                  </button>
                  <button className="rounded-md border px-2 py-1" onClick={() => void loadAudit(c.id)} disabled={busy !== null}>گزارش رویدادها</button>
                  <button className="rounded-md border border-red-200 px-2 py-1 text-red-700" onClick={() => call(`/api/integrations/connections/${c.id}`, "DELETE")} disabled={busy !== null}>حذف</button>
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <span>دریافتی: {c.inbox.processed ?? 0} | خطا: {c.inbox.failed ?? 0}</span>
                  <span>ارسال: {c.outbox.sent ?? 0} | در صف: {(c.outbox.pending ?? 0) + (c.outbox.failed ?? 0)} | خطای دائمی: {c.outbox.dead ?? 0}</span>
                </div>
                {auditFor === c.id && (
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-md bg-stone-50 p-2 text-xs">
                    {audit.map((a) => (
                      <div key={a.id} className="flex justify-between gap-2 border-b border-stone-100 py-1">
                        <span>{ACTION_LABELS[a.action] ?? a.action}</span>
                        <span className="text-muted-foreground">{a.remoteId ?? a.entityType ?? ""}</span>
                        <span className="text-muted-foreground">{new Date(a.createdAt).toLocaleString("fa-IR")}</span>
                        {a.error && <span className="text-red-600">{a.error}</span>}
                      </div>
                    ))}
                    {audit.length === 0 && <p>رویدادی ثبت نشده است.</p>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
