"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * «نرم‌افزار هلو» — the Holoo connection panel (Phase 26).
 *
 * Wave 2 scope: create a Holoo connection (SQL Server host/port/database +
 * optional credentials, currency unit, write mode), list them, and run the
 * connection test which probes the version and matches a schema profile. The
 * migration wizard (Wave 6) and companion-mode mirroring (Wave 7) build on
 * this connection later; here there is only the connection itself.
 */
import { useCallback, useEffect, useState } from "react";
import { api, ErrorBox, errorMessageOrRaw, InfoBox, inputClass } from "../ui";
import { Button } from "@/components/ui/button";
import { SectionCard } from "../page-chrome";

interface Connection {
  id: string;
  name: string;
  provider: string;
  status: "active" | "paused" | "error";
  lastError: string | null;
}

interface HolooSettings {
  host: string;
  port: number;
  database: string;
  webServiceBaseUrl: string | null;
  holooVersion: string | null;
  schemaProfile: string | null;
  currencyUnit: "rial" | "toman";
  writeMode: "none" | "web_service" | "direct_sql";
  directSqlArmedAt: string | null;
  directSqlProfileKey: string | null;
  companionActivatedAt: string | null;
  hasSqlCredentials: boolean;
  hasWebServiceCredentials: boolean;
}

interface HolooHealth {
  status: "active" | "paused" | "error" | "missing";
  lastError: string | null;
  cursorLagMinutes: number | null;
  outboxDepth: number;
  deadLetters: number;
}

interface ListedConnection extends Connection {
  settings: HolooSettings | null;
  health: HolooHealth | null;
}

const WRITE_MODE_LABELS: Record<string, string> = {
  none: "بدون نوشتن (فقط خواندن / مهاجرت)",
  web_service: "وب‌سرویس هلو",
  direct_sql: "SQL مستقیم (محافظت‌شده)",
};

export function HolooPanel() {
  const [connections, setConnections] = useState<ListedConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [directSqlConfirmation, setDirectSqlConfirmation] = useState<Record<string, string>>({});

  // Create form state.
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("1433");
  const [database, setDatabase] = useState("");
  const [sqlUser, setSqlUser] = useState("");
  const [sqlPassword, setSqlPassword] = useState("");
  const [webServiceBaseUrl, setWebServiceBaseUrl] = useState("");
  const [wsUser, setWsUser] = useState("");
  const [wsPassword, setWsPassword] = useState("");
  const [currencyUnit, setCurrencyUnit] = useState<"rial" | "toman">("rial");
  const [writeMode, setWriteMode] = useState<"none" | "web_service" | "direct_sql">("none");

  const load = useCallback(async () => {
    setLoading(true);
    const res = await api<{ connections: Connection[] }>("/api/integrations/connections");
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      setLoading(false);
      return;
    }
    const holoo = res.data.connections.filter((c) => c.provider === "holoo");
    const listed: ListedConnection[] = [];
    for (const c of holoo) {
      const settingsRes = await api<{ settings: HolooSettings; health: HolooHealth }>(`/api/integrations/connections/${c.id}/holoo`);
      listed.push({ ...c, settings: settingsRes.ok ? settingsRes.data.settings : null, health: settingsRes.ok ? settingsRes.data.health : null });
    }
    setConnections(listed);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    const res = await api("/api/integrations/connections", {
      method: "POST",
      body: JSON.stringify({
        provider: "holoo",
        name,
        host,
        port: Number(port),
        database,
        sqlUser: sqlUser || undefined,
        sqlPassword: sqlPassword || undefined,
        webServiceBaseUrl: webServiceBaseUrl || undefined,
        wsUser: wsUser || undefined,
        wsPassword: wsPassword || undefined,
        currencyUnit,
        writeMode,
      }),
    });
    if (!res.ok) {
      setError(errorMessageOrRaw((res.data as { error?: string }).error));
      setCreating(false);
      return;
    }
    setName("");
    setHost("");
    setDatabase("");
    setSqlUser("");
    setSqlPassword("");
    setWebServiceBaseUrl("");
    setWsUser("");
    setWsPassword("");
    setCreating(false);
    await load();
  }

  async function test(id: string) {
    setTesting(id);
    setTestResult((prev) => ({ ...prev, [id]: "" }));
    const res = await api<{ ok: boolean; error?: string; version?: string; profile?: { label: string } | null }>(
      `/api/integrations/connections/${id}/test`,
      { method: "POST" },
    );
    if (!res.ok) {
      setTestResult((prev) => ({ ...prev, [id]: `خطا: ${errorMessageOrRaw(res.data.error)}` }));
    } else if (res.data.ok) {
      const profile = res.data.profile ? `، پروفایل: ${res.data.profile.label}` : "، پروفایل ناشناخته";
      setTestResult((prev) => ({ ...prev, [id]: `نسخهٔ ${res.data.version ?? "نامشخص"}${profile}` }));
    } else {
      setTestResult((prev) => ({ ...prev, [id]: `خطا: ${errorMessageOrRaw(res.data.error)}` }));
    }
    setTesting(null);
    await load();
  }

  async function setCompanion(id: string, active: boolean) {
    setActionBusy(`${id}:companion`);
    const res = await api<{ error?: string }>(`/api/integrations/connections/${id}/holoo/companion`, {
      method: "POST",
      body: JSON.stringify({ active }),
    });
    if (!res.ok) setError(errorMessageOrRaw(res.data.error));
    setActionBusy(null);
    await load();
  }

  async function armDirectSql(id: string) {
    setActionBusy(`${id}:direct`);
    const res = await api<{ error?: string }>(`/api/integrations/connections/${id}/holoo/direct-sql`, {
      method: "POST",
      body: JSON.stringify({ confirmation: directSqlConfirmation[id] ?? "" }),
    });
    if (!res.ok) setError(errorMessageOrRaw(res.data.error));
    else setDirectSqlConfirmation((prev) => ({ ...prev, [id]: "" }));
    setActionBusy(null);
    await load();
  }

  return (
    <div className="space-y-6">
      <SectionCard title="اتصال تازه به هلو" description="هاست و نام دیتابیس SQL Server هلو روی شبکهٔ محلی. رمز عبور هرگز به رابط کاربری برنمی‌گردد.">
        <form onSubmit={create} className="space-y-3">
          <input className={inputClass} placeholder="نام اتصال" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input className={inputClass} placeholder="هاست (مثلاً 192.168.1.10)" value={host} onChange={(e) => setHost(e.target.value)} dir="ltr" />
            <input className={inputClass} placeholder="پورت" value={port} onChange={(e) => setPort(e.target.value)} dir="ltr" inputMode="numeric" />
            <input className={inputClass} placeholder="نام دیتابیس" value={database} onChange={(e) => setDatabase(e.target.value)} dir="ltr" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input className={inputClass} placeholder="کاربر SQL (اختیاری)" value={sqlUser} onChange={(e) => setSqlUser(e.target.value)} dir="ltr" />
            <input className={inputClass} placeholder="رمز SQL (اختیاری)" type="password" value={sqlPassword} onChange={(e) => setSqlPassword(e.target.value)} dir="ltr" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <input className={inputClass} placeholder="آدرس وب‌سرویس هلو (برای نوشتن)" value={webServiceBaseUrl} onChange={(e) => setWebServiceBaseUrl(e.target.value)} dir="ltr" />
            <input className={inputClass} placeholder="کاربر وب‌سرویس" value={wsUser} onChange={(e) => setWsUser(e.target.value)} dir="ltr" />
            <input className={inputClass} placeholder="رمز وب‌سرویس" type="password" value={wsPassword} onChange={(e) => setWsPassword(e.target.value)} dir="ltr" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="text-sm text-muted-foreground">
              واحد پول
              <select className={inputClass} value={currencyUnit} onChange={(e) => setCurrencyUnit(e.target.value as "rial" | "toman")}>
                <option value="rial">ریال</option>
                <option value="toman">تومان</option>
              </select>
            </label>
            <label className="text-sm text-muted-foreground">
              حالت نوشتن
              <select className={inputClass} value={writeMode} onChange={(e) => setWriteMode(e.target.value as "none" | "web_service" | "direct_sql")}>
                <option value="none">بدون نوشتن</option>
                <option value="web_service">وب‌سرویس هلو</option>
                <option value="direct_sql">SQL مستقیم</option>
              </select>
            </label>
          </div>
          <Button type="submit" disabled={creating || !host || !database}>
            {creating ? "در حال ایجاد…" : "ایجاد اتصال"}
          </Button>
        </form>
      </SectionCard>

      {error ? <ErrorBox>{error}</ErrorBox> : null}

      <SectionCard title="اتصال‌های هلو">
        {loading ? (
          <LoadingSkeleton rows={3} />
        ) : connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">هنوز اتصالی به هلو ایجاد نشده است.</p>
        ) : (
          <div className="space-y-3">
            {connections.map((c) => (
              <div key={c.id} className="rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{c.name}</span>
                  <span className="text-xs text-muted-foreground">{c.status}</span>
                </div>
                {c.settings ? (
                  <div className="mt-1 text-xs text-muted-foreground" dir="ltr">
                    {c.settings.host}:{c.settings.port} / {c.settings.database}
                    <span dir="rtl" className="block">
                      واحد: {c.settings.currencyUnit === "rial" ? "ریال" : "تومان"} · نوشتن: {WRITE_MODE_LABELS[c.settings.writeMode]}
                      {c.settings.holooVersion ? ` · نسخه: ${c.settings.holooVersion}` : ""}
                      {c.settings.schemaProfile ? ` · پروفایل: ${c.settings.schemaProfile}` : ""}
                      {c.settings.companionActivatedAt ? " · حالت همراه فعال" : ""}
                      {c.settings.directSqlArmedAt ? ` · SQL مستقیم مسلح (${c.settings.directSqlProfileKey ?? "بدون پروفایل"})` : ""}
                    </span>
                    {c.health ? (
                      <span dir="rtl" className="mt-1 block">
                        سلامت: {c.health.status} · تأخیر آینه: {c.health.cursorLagMinutes === null ? "هنوز اجرا نشده" : `${c.health.cursorLagMinutes} دقیقه`} · صف ارسال: {c.health.outboxDepth} · مرده: {c.health.deadLetters}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" disabled={testing === c.id} onClick={() => test(c.id)}>
                    {testing === c.id ? "در حال تست…" : "تست اتصال"}
                  </Button>
                  <Button type="button" size="sm" variant="outline" disabled={actionBusy === `${c.id}:companion`} onClick={() => setCompanion(c.id, !c.settings?.companionActivatedAt)}>
                    {c.settings?.companionActivatedAt ? "خاموش‌کردن همراه" : "فعال‌کردن همراه"}
                  </Button>
                  <a className="text-xs text-primary underline-offset-4 hover:underline" href={`/dashboard/integrations/holoo?connectionId=${c.id}`}>ویزارد مهاجرت</a>
                  {testResult[c.id] ? <span className="text-xs text-muted-foreground">{testResult[c.id]}</span> : null}
                </div>
                {c.settings?.writeMode === "direct_sql" ? (
                  <div className="mt-3 flex flex-col gap-2 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 p-3 sm:flex-row sm:items-center">
                    <input
                      className={inputClass}
                      placeholder="برای مسلح‌سازی بنویسید: holoo-direct-sql"
                      value={directSqlConfirmation[c.id] ?? ""}
                      onChange={(e) => setDirectSqlConfirmation((prev) => ({ ...prev, [c.id]: e.target.value }))}
                      dir="ltr"
                    />
                    <Button type="button" size="sm" variant="outline" disabled={actionBusy === `${c.id}:direct`} onClick={() => armDirectSql(c.id)}>
                      مسلح‌سازی SQL مستقیم
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>

      <InfoBox>
        خواندن همیشه از SQL Server هلو انجام می‌شود. اگر حالت همراه را فعال کنید، دفتر رسمی در هلو می‌ماند؛ اپ آینهٔ فقط‌خواندنی، صف ارسال فروش/دریافت/خرید، سلامت اتصال و تطبیق را نشان می‌دهد.
      </InfoBox>
    </div>
  );
}
