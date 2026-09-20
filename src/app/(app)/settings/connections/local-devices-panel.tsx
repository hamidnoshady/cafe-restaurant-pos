"use client";

import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBox, InfoBox, PrimaryButton, SecondaryButton } from "@/app/dashboard/ui";
import { SectionCard } from "@/app/dashboard/page-chrome";

interface LanInterface {
  name: string;
  address: string;
  netmask: string;
  mac: string;
}
interface GatewayStatus {
  supported: boolean;
  enabled: boolean;
  running: boolean;
  computerName: string;
  interfaces: LanInterface[];
  selectedAddress: string | null;
  port: number;
  url: string | null;
  caDownloadUrl: string | null;
  addressActive: boolean;
  certificate: {
    exists: boolean;
    fingerprint?: string;
    caFingerprint?: string;
    expiresAt?: string;
  };
  firewall: { supported: boolean; installed: boolean; error?: string };
  clients: Array<{ address: string; kind: string; lastSeenAt: string }>;
  logPath: string;
}
interface DesktopBridge {
  isDesktop: true;
  localGateway: {
    status(): Promise<GatewayStatus>;
    enable(address: string): Promise<GatewayStatus>;
    disable(): Promise<GatewayStatus>;
    installFirewallRule(): Promise<GatewayStatus>;
    removeFirewallRule(): Promise<GatewayStatus>;
    regenerateCertificate(): Promise<GatewayStatus>;
    showCaCertificate(): Promise<string>;
    openLogs(): Promise<string>;
  };
}

declare global {
  interface Window {
    businessSuiteDesktop?: DesktopBridge;
  }
}

function State({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return <span className={ok ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300"}>{ok ? yes : no}</span>;
}

async function copy(value: string | null) {
  if (value) await navigator.clipboard.writeText(value);
}

export function LocalDevicesPanel() {
  const bridge = typeof window === "undefined" ? undefined : window.businessSuiteDesktop;
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [siteQr, setSiteQr] = useState("");
  const [caQr, setCaQr] = useState("");

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      const next = await bridge.localGateway.status();
      setStatus(next);
      setSelected((current) => current || next.selectedAddress || next.interfaces[0]?.address || "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "خواندن وضعیت اتصال محلی ممکن نشد.");
    }
  }, [bridge]);

  useEffect(() => {
    void refresh();
    if (!bridge) return;
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [bridge, refresh]);

  useEffect(() => {
    let cancelled = false;
    async function render() {
      const [site, ca] = await Promise.all([
        status?.url ? QRCode.toDataURL(status.url, { width: 220, margin: 1, errorCorrectionLevel: "M" }) : "",
        status?.caDownloadUrl ? QRCode.toDataURL(status.caDownloadUrl, { width: 180, margin: 1, errorCorrectionLevel: "M" }) : "",
      ]);
      if (!cancelled) { setSiteQr(site); setCaQr(ca); }
    }
    void render();
    return () => { cancelled = true; };
  }, [status?.url, status?.caDownloadUrl]);

  const selectedInterface = useMemo(
    () => status?.interfaces.find((item) => item.address === selected),
    [selected, status?.interfaces],
  );

  async function run(action: () => Promise<GatewayStatus>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await action();
      setStatus(next);
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "عملیات انجام نشد.");
    } finally {
      setBusy(false);
    }
  }

  if (!bridge) {
    return (
      <SectionCard title="اتصال دستگاه‌های محلی">
        <InfoBox>
          مدیریت درگاه شبکه و فایروال فقط داخل برنامهٔ ویندوز Business Suite در دسترس است. این صفحه را روی رایانهٔ میزبان باز کنید؛ سرور ابری یا مرورگر عادی نباید پورت شبکهٔ رایانه را مدیریت کند.
        </InfoBox>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      <SectionCard title="وضعیت سرور محلی">
        <ErrorBox>{error}</ErrorBox>
        {notice ? <InfoBox>{notice}</InfoBox> : null}
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-muted-foreground">نام رایانه</dt><dd dir="ltr" className="font-mono">{status?.computerName || "—"}</dd></div>
          <div><dt className="text-muted-foreground">سرور داخلی</dt><dd><State ok={true} yes="فعال روی حلقهٔ محلی" no="غیرفعال" /></dd></div>
          <div><dt className="text-muted-foreground">دسترسی موبایل</dt><dd><State ok={Boolean(status?.running)} yes="HTTPS فعال" no="غیرفعال" /></dd></div>
          <div><dt className="text-muted-foreground">فایروال ویندوز</dt><dd><State ok={Boolean(status?.firewall.installed)} yes="قانون شبکهٔ Private فعال" no="قانون فعال نیست" /></dd></div>
          <div><dt className="text-muted-foreground">پورت درگاه</dt><dd dir="ltr" className="font-mono">{status?.port ?? 8443}</dd></div>
          <div><dt className="text-muted-foreground">گواهی</dt><dd><State ok={Boolean(status?.certificate.exists)} yes="ساخته شده" no="ساخته نشده" /></dd></div>
        </dl>
        {status?.enabled && !status.addressActive ? (
          <div className="mt-4"><ErrorBox>نشانی شبکهٔ ذخیره‌شده دیگر فعال نیست. شبکهٔ فعلی را انتخاب و درگاه را دوباره فعال کنید.</ErrorBox></div>
        ) : null}
      </SectionCard>

      <SectionCard title="شبکهٔ تلفن و تبلت">
        <label className="mb-2 block text-sm font-medium" htmlFor="lan-interface">کارت شبکهٔ خصوصی</label>
        <select
          id="lan-interface"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          disabled={busy || Boolean(status?.running)}
          className="h-11 w-full rounded-lg border border-input bg-background px-3 text-sm"
        >
          {(status?.interfaces ?? []).map((item) => (
            <option key={`${item.name}:${item.address}`} value={item.address}>{item.name} — {item.address}</option>
          ))}
        </select>
        {selectedInterface ? <p className="mt-2 text-xs text-muted-foreground">نشانی خصوصی: <span dir="ltr" className="font-mono">{selectedInterface.address}</span></p> : null}
        {!status?.interfaces.length ? <ErrorBox>شبکهٔ خصوصی فعالی پیدا نشد. Wi-Fi یا Ethernet را وصل کنید؛ آداپتورهای Docker، WSL و مجازی عمداً نمایش داده نمی‌شوند.</ErrorBox> : null}
        <div className="mt-4 flex flex-wrap gap-2">
          {!status?.running ? (
            <PrimaryButton disabled={busy || !selected} onClick={() => run(() => bridge.localGateway.enable(selected), "درگاه امن بدون نیاز به دسترسی مدیر فعال شد. اگر فایروال اتصال را مسدود می‌کند، قانون اختیاری را جداگانه اضافه کنید.")}>
              {busy ? "در حال فعال‌سازی…" : "فعال‌کردن دسترسی موبایل"}
            </PrimaryButton>
          ) : (
            <PrimaryButton disabled={busy} onClick={() => run(() => bridge.localGateway.disable(), "دسترسی موبایل غیرفعال شد. قانون فایروال، در صورت نصب، جداگانه قابل حذف است.")}>
              غیرفعال‌کردن دسترسی موبایل
            </PrimaryButton>
          )}
          {status?.firewall.supported && !status.firewall.installed ? (
            <SecondaryButton disabled={busy} onClick={() => run(() => bridge.localGateway.installFirewallRule(), "قانون محدود فایروال نصب شد.")}>
              افزودن قانون فایروال (نیازمند UAC)
            </SecondaryButton>
          ) : null}
          {status?.firewall.supported && status.firewall.installed ? (
            <SecondaryButton disabled={busy} onClick={() => run(() => bridge.localGateway.removeFirewallRule(), "قانون فایروال حذف شد.")}>
              حذف قانون فایروال (نیازمند UAC)
            </SecondaryButton>
          ) : null}
          <SecondaryButton disabled={busy || !status?.certificate.exists} onClick={() => run(() => bridge.localGateway.regenerateCertificate(), "گواهی درگاه بازسازی شد. CA محلی تغییر نکرده است.")}>
            بازسازی گواهی
          </SecondaryButton>
          <SecondaryButton onClick={() => void bridge.localGateway.openLogs()}>بازکردن گزارش‌ها</SecondaryButton>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          درخواست دسترسی مدیر ویندوز فقط برای افزودن یا حذف قانون ورودی TCP همین پورت، روی پروفایل Private، برای همین برنامه و محدودهٔ LocalSubnet است. PostgreSQL و Print Connector هرگز در فایروال باز نمی‌شوند.
        </p>
      </SectionCard>

      {status?.running && status.url ? (
        <SectionCard title="اتصال تلفن یا تبلت">
          <div className="grid gap-6 md:grid-cols-[240px_1fr]">
            <div className="rounded-xl border bg-white p-2">{siteQr ? <img src={siteQr} alt="QR نشانی سرور محلی" width={220} height={220} /> : null}</div>
            <div className="space-y-3">
              <p className="text-sm">ابتدا گواهی محلی را روی دستگاه نصب و به آن اعتماد کنید، سپس QR بزرگ را اسکن کنید.</p>
              <div className="flex flex-wrap items-center gap-2">
                <code dir="ltr" className="select-all rounded-lg border bg-muted/40 px-3 py-2 text-sm">{status.url}</code>
                <SecondaryButton onClick={() => void copy(status.url)}>کپی نشانی</SecondaryButton>
              </div>
              <p className="text-xs leading-6 text-muted-foreground">
                Android: فایل CA را نصب کنید و برای VPN و برنامه‌ها به آن اعتماد دهید. iOS/iPadOS: Profile را نصب کنید، سپس در Settings → General → About → Certificate Trust Settings اعتماد کامل را روشن کنید. تبلت ویندوز: گواهی را در Trusted Root Certification Authorities نصب کنید.
              </p>
            </div>
          </div>
          <div className="mt-6 border-t pt-5">
            <h3 className="mb-2 text-sm font-semibold">گواهی ریشهٔ محلی</h3>
            <div className="flex flex-wrap items-center gap-4">
              {caQr ? <div className="rounded-lg border bg-white p-2"><img src={caQr} alt="QR دریافت گواهی محلی" width={160} height={160} /></div> : null}
              <div className="min-w-0 space-y-2 text-xs">
                <p>اثر انگشت CA:</p>
                <code dir="ltr" className="block break-all rounded border bg-muted/40 p-2">{status.certificate.caFingerprint || "—"}</code>
                <SecondaryButton onClick={() => void bridge.localGateway.showCaCertificate()}>نمایش فایل گواهی در ویندوز</SecondaryButton>
              </div>
            </div>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="دستگاه‌های دیده‌شده و رفع اشکال">
        {status?.clients.length ? (
          <ul className="space-y-2 text-sm">
            {status.clients.map((client) => (
              <li key={`${client.kind}:${client.address}`} className="flex justify-between rounded-lg border p-3">
                <span dir="ltr" className="font-mono">{client.address}</span>
                <span className="text-muted-foreground">{client.kind === "websocket" ? "هم‌زمان" : "HTTPS"} — {new Date(client.lastSeenAt).toLocaleTimeString("fa-IR")}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted-foreground">هنوز دستگاهی به درگاه وصل نشده است.</p>}
        <ol className="mt-4 list-decimal space-y-1 pr-5 text-xs leading-6 text-muted-foreground">
          <li>رایانه و تلفن باید روی یک Wi-Fi یا LAN خصوصی باشند؛ شبکهٔ Guest معمولاً ارتباط دستگاه‌ها را مسدود می‌کند.</li>
          <li>پروفایل شبکهٔ ویندوز باید Private باشد و پنجرهٔ UAC افزودن قانون فایروال تأیید شود.</li>
          <li>خطای گواهی یعنی CA نصب یا Trusted نشده، یا IP شبکه تغییر کرده است؛ کارت شبکه را دوباره انتخاب و گواهی را بازسازی کنید.</li>
          <li>قطع اینترنت به عملیات محلی آسیب نمی‌زند؛ قطع LAN فقط اقدامات پشتیبانی‌شده را در صف دستگاه نگه می‌دارد.</li>
        </ol>
      </SectionCard>
    </div>
  );
}
