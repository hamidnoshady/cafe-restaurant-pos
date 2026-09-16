"use client";

/**
 * «چاپگرها» — pairing hardware, and finding it rather than typing it.
 *
 * The old screen asked for an IP and a port, which assumed every printer is a
 * network ESC/POS box and that whoever installs the till knows its address.
 * Most don't: the printer is already installed in Windows, or it is on the
 * Wi-Fi with an address nobody wrote down. So this screen leads with two
 * discovery buttons — the OS's installed queues, and a sweep of the local
 * network — and pairing is picking a row from a list. Typing an address by
 * hand is still there, one tab over, because a printer on another subnet
 * cannot be swept for.
 */
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2Icon, DownloadIcon, PlugZapIcon, RadarIcon, RefreshCwIcon, UsbIcon, XCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Switch } from "@/components/ui/switch";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  kickDrawer,
  listSystemPrinters,
  probePrinter,
  scanLanPrinters,
  testPrint,
  type LanPrinter,
  type SystemPrinter,
} from "@/lib/print-agent-client";
import { requestWebUsbPrinter, webUsbSupported } from "@/lib/webusb-print";
import {
  PRINTER_TRANSPORT_LABELS,
  describeConnection,
  resolvedTransport,
  type PrinterConnection,
  type PrinterTransport,
} from "@/lib/printer-connection";
import { BUILT_IN_TEMPLATES, PAPERS, PAPER_KEYS, type PaperKey } from "@/lib/print-template";
import { EmptyState, LoadingSkeleton, SectionCard } from "@/app/dashboard/page-chrome";
import { ErrorBox, Field, InfoBox, api, errorMessage, inputClass } from "@/app/dashboard/ui";
import type { PrinterRow, SavedTemplateRow } from "./use-printing";

interface Draft {
  name: string;
  kind: "receipt" | "kitchen";
  transport: PrinterTransport;
  ip: string;
  port: string;
  systemName: string;
  devicePath: string;
  usbVendorId: number | null;
  usbProductId: number | null;
  usbSerial: string | null;
  usbProductName: string | null;
  paper: PaperKey;
  templateKey: string;
  openDrawer: boolean;
  isActive: boolean;
  isDefault: boolean;
}

const EMPTY: Draft = {
  name: "",
  kind: "receipt",
  transport: "network",
  ip: "",
  port: "9100",
  systemName: "",
  devicePath: "",
  usbVendorId: null,
  usbProductId: null,
  usbSerial: null,
  usbProductName: null,
  paper: "thermal80",
  templateKey: "",
  openDrawer: false,
  isActive: true,
  isDefault: false,
};

function toDraft(printer: PrinterRow): Draft {
  const c = printer.connection ?? {};
  return {
    name: printer.name,
    kind: printer.kind,
    transport: resolvedTransport(c),
    ip: c.ip ?? "",
    port: String(c.port ?? 9100),
    systemName: c.systemName ?? "",
    devicePath: c.devicePath ?? "",
    usbVendorId: c.usbVendorId ?? null,
    usbProductId: c.usbProductId ?? null,
    usbSerial: c.usbSerial ?? null,
    usbProductName: c.usbProductName ?? null,
    paper: (c.paper as PaperKey) ?? (c.paperWidthMm === 58 ? "thermal58" : "thermal80"),
    templateKey: c.templateKey ?? "",
    openDrawer: c.openDrawer === true,
    isActive: printer.is_active,
    isDefault: c.isDefault === true,
  };
}

function payload(draft: Draft) {
  const paper = PAPERS[draft.paper];
  return {
    name: draft.name,
    kind: draft.kind,
    transport: draft.transport,
    ip: draft.ip,
    port: Number(draft.port) || 9100,
    systemName: draft.systemName,
    devicePath: draft.devicePath,
    usbVendorId: draft.usbVendorId,
    usbProductId: draft.usbProductId,
    usbSerial: draft.usbSerial,
    usbProductName: draft.usbProductName,
    paper: draft.paper,
    // Kept in step with `paper` so the ESC/POS raster path (which only knows
    // 58/80) still gets the right width from an old-shaped read.
    paperWidthMm: paper.widthMm <= 58 ? 58 : 80,
    driverMode: paper.kind === "sheet" ? "document" : "raster",
    templateKey: draft.templateKey || null,
    openDrawer: draft.openDrawer,
    isActive: draft.isActive,
    isDefault: draft.isDefault,
  };
}

function connectionOf(draft: Draft): PrinterConnection {
  const p = payload(draft);
  return {
    transport: p.transport,
    ip: p.ip,
    port: p.port,
    systemName: p.systemName,
    devicePath: p.devicePath,
    usbVendorId: p.usbVendorId,
    usbProductId: p.usbProductId,
    usbSerial: p.usbSerial,
    usbProductName: p.usbProductName,
    paper: p.paper,
    paperWidthMm: p.paperWidthMm as 58 | 80,
    driverMode: p.driverMode as "raster" | "document",
    openDrawer: p.openDrawer,
  };
}

export function PrinterHardware({
  printers,
  loading,
  templates,
  localAgentOnline,
  onChanged,
}: {
  printers: PrinterRow[];
  loading: boolean;
  templates: SavedTemplateRow[];
  localAgentOnline: boolean;
  onChanged: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [systemPrinters, setSystemPrinters] = useState<SystemPrinter[] | null>(null);
  const [systemVia, setSystemVia] = useState<"agent" | "server" | null>(null);
  const [lanPrinters, setLanPrinters] = useState<LanPrinter[] | null>(null);
  const [discovering, setDiscovering] = useState<"system" | "lan" | null>(null);

  const templateOptions = [
    { value: "", label: "پیش‌فرض این نوع سند" },
    ...BUILT_IN_TEMPLATES.map((t) => ({ value: t.key, label: `${t.name} (آماده)` })),
    ...templates.map((t) => ({ value: t.id, label: t.name })),
  ];

  const discoverSystem = useCallback(async () => {
    setDiscovering("system");
    setError("");
    // The client tries the loopback print agent first, then falls back to the
    // app server's /api/print/system-printers — so on a local deployment the
    // Windows list appears with nothing extra running on this device.
    const result = await listSystemPrinters();
    setDiscovering(null);
    if (!result.ok) {
      setError(
        result.unreachable
          ? "نه عامل چاپ محلی در دسترس است و نه سرور برنامه توانست چاپگرها را بخواند؛ عامل چاپ را روی همین دستگاه اجرا کنید تا چاپگرهای نصب‌شدهٔ ویندوز خوانده شوند."
          : "خواندن فهرست چاپگرهای سیستم ممکن نشد.",
      );
      return;
    }
    const found = result.data?.printers ?? [];
    setSystemPrinters(found);
    setSystemVia(result.via ?? "agent");
    if (result.via === "server") {
      setNotice(
        "عامل چاپ این کامپیوتر پاسخ نداد؛ فهرست زیر مربوط به دستگاه سرور است، نه ویندوز شما. برای چاپگر USB نصب‌شده در ویندوز، عامل چاپ را روی همین کامپیوتر اجرا کنید و دسترسی Apps on device / Local network access مرورگر را Allow کنید.",
      );
    }
  }, []);

  const discoverLan = useCallback(async () => {
    setDiscovering("lan");
    setError("");
    const result = await scanLanPrinters();
    setDiscovering(null);
    if (!result.ok) {
      setError(
        result.unreachable
          ? "نه عامل چاپ محلی در دسترس است و نه سرور برنامه؛ جست‌وجوی شبکه از روی دستگاهی انجام می‌شود که به شبکهٔ چاپگر وصل است."
          : "جست‌وجوی شبکه ناموفق بود.",
      );
      return;
    }
    setLanPrinters(result.data?.printers ?? []);
  }, []);

  // Reading the OS's printer list is instant and needs no network, so it runs
  // as soon as the agent says it is up — the common case is "pick yours".
  useEffect(() => {
    // Auto-discovery is useful only when the answer comes from this Windows
    // PC. A cloud server's empty CUPS list is not the user's Windows list and
    // must not look like successful local discovery.
    if (localAgentOnline && systemPrinters === null) void discoverSystem();
  }, [localAgentOnline, systemPrinters, discoverSystem]);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>("/api/settings/printers", {
      method: "POST",
      body: JSON.stringify(payload(draft)),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setDraft(EMPTY);
    setNotice("چاپگر جدید ثبت شد.");
    await onChanged();
  }

  async function save(printer: PrinterRow, next: Draft) {
    setBusy(true);
    setError("");
    setNotice("");
    const { ok, data } = await api<{ error?: string }>(`/api/settings/printers/${printer.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload(next)),
    });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("تنظیمات چاپگر ذخیره شد.");
    await onChanged();
  }

  async function remove(printer: PrinterRow) {
    if (!window.confirm(`چاپگر «${printer.name}» حذف شود؟`)) return;
    setBusy(true);
    const { ok, data } = await api<{ error?: string }>(`/api/settings/printers/${printer.id}`, { method: "DELETE" });
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setNotice("چاپگر حذف شد.");
    await onChanged();
  }

  function useSystemPrinter(printer: SystemPrinter) {
    setDraft((prev) => ({
      ...prev,
      transport: "system",
      systemName: printer.name,
      name: prev.name || printer.name,
      paper: printer.likelyThermal ? "thermal80" : "a4",
    }));
    setNotice(`«${printer.name}» در فرم زیر قرار گرفت؛ نام و نوع را بررسی و ذخیره کنید.`);
  }

  function useLanPrinter(printer: LanPrinter) {
    setDraft((prev) => ({
      ...prev,
      transport: "network",
      ip: printer.ip,
      port: String(printer.port),
      name: prev.name || `چاپگر ${printer.ip}`,
    }));
    setNotice(`${printer.ip} در فرم زیر قرار گرفت؛ نام و نوع را بررسی و ذخیره کنید.`);
  }

  /**
   * The `webusb` pairing flow — for a server installation where neither the
   * agent nor the server can see the till's USB printer, but this very
   * browser can. One chooser dialog, once; afterwards every job renders on
   * the server and travels down this browser's USB cable with no print modal.
   */
  async function pairWebUsbPrinter() {
    setError("");
    const result = await requestWebUsbPrinter();
    if (!result.ok) {
      setError(
        result.error === "unsupported"
          ? "این مرورگر WebUSB را پشتیبانی نمی‌کند؛ از Chrome یا Edge (روی HTTPS) استفاده کنید."
          : "چاپگری انتخاب نشد.",
      );
      return;
    }
    setDraft((prev) => ({
      ...prev,
      transport: "webusb",
      usbVendorId: result.printer.usbVendorId,
      usbProductId: result.printer.usbProductId,
      usbSerial: result.printer.usbSerial,
      usbProductName: result.printer.usbProductName,
      name: prev.name || result.printer.usbProductName || "چاپگر USB",
      paper: prev.paper === "a4" ? "thermal80" : prev.paper,
    }));
    setNotice(
      `«${result.printer.usbProductName || "چاپگر USB"}» به مرورگر متصل شد و در فرم زیر قرار گرفت؛ نام و نوع را بررسی و ذخیره کنید.`,
    );
  }

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}
      <WindowsConnectorCard localAgentOnline={localAgentOnline} />

      <SectionCard
        title="پیداکردن چاپگر"
        description="چاپگرهای نصب‌شده روی این دستگاه و چاپگرهای شبکه را به‌جای وارد‌کردن دستی آدرس، از فهرست انتخاب کنید."
        actions={
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => void discoverSystem()} disabled={discovering !== null}>
              <RefreshCwIcon aria-hidden="true" />
              {discovering === "system" ? "در حال خواندن…" : "چاپگرهای ویندوز"}
            </Button>
            <Button type="button" variant="outline" onClick={() => void discoverLan()} disabled={discovering !== null}>
              <RadarIcon aria-hidden="true" />
              {discovering === "lan" ? "در حال جست‌وجو…" : "جست‌وجوی شبکه"}
            </Button>
            {webUsbSupported() ? (
              <Button type="button" variant="outline" onClick={() => void pairWebUsbPrinter()} disabled={discovering !== null}>
                <UsbIcon aria-hidden="true" />
                اتصال USB از مرورگر
              </Button>
            ) : null}
          </div>
        }
      >
        {discovering ? (
          <LoadingSkeleton rows={3} label="در حال شناسایی چاپگرها" />
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            <DiscoveryList
              title={systemVia === "server" ? "نصب‌شده روی دستگاه سرور" : "نصب‌شده روی این دستگاه"}
              hint={
                systemVia === "server"
                  ? "فهرست چاپگرهای دستگاهی که سرور برنامه روی آن اجراست (عامل چاپ محلی اجرا نیست)."
                  : "همان فهرستی که در «Printers & scanners» ویندوز می‌بینید."
              }
              empty={
                systemPrinters === null
                  ? "برای خواندن فهرست، دکمهٔ بالا را بزنید."
                  : "چاپگری روی این دستگاه نصب نشده است."
              }
              rows={(systemPrinters ?? []).map((printer) => ({
                key: printer.name,
                title: printer.name,
                subtitle: [printer.driver, printer.port, printer.isDefault ? "پیش‌فرض ویندوز" : null]
                  .filter(Boolean)
                  .join(" · "),
                tag: printer.likelyThermal ? "حرارتی" : "برگه‌ای",
                onUse: () => useSystemPrinter(printer),
              }))}
            />
            <DiscoveryList
              title="روی شبکهٔ محلی"
              hint="جست‌وجوی پورت ۹۱۰۰ روی شبکهٔ همین دستگاه؛ چند ثانیه طول می‌کشد."
              empty={
                lanPrinters === null
                  ? "برای جست‌وجوی شبکه، دکمهٔ بالا را بزنید."
                  : "چاپگری روی شبکه پیدا نشد؛ آدرس را دستی وارد کنید."
              }
              rows={(lanPrinters ?? []).map((printer) => ({
                key: `${printer.ip}:${printer.port}`,
                title: printer.ip,
                subtitle: `پورت ${printer.port} · ${printer.latencyMs} میلی‌ثانیه`,
                tag: "شبکه",
                onUse: () => useLanPrinter(printer),
              }))}
            />
          </div>
        )}
      </SectionCard>

      <SectionCard title="افزودن چاپگر" description="نوع اتصال را انتخاب کنید؛ فقط فیلدهای همان اتصال پرسیده می‌شود.">
        <PrinterForm
          value={draft}
          onChange={setDraft}
          onSubmit={create}
          submitLabel="افزودن چاپگر"
          busy={busy}
          templateOptions={templateOptions}
        />
      </SectionCard>

      <SectionCard
        title="چاپگرهای این شعبه"
        description="هر نوع چاپگر یک پیش‌فرض دارد؛ صندوق از همان برای چاپ خودکار استفاده می‌کند."
      >
        {loading ? (
          <LoadingSkeleton rows={3} />
        ) : printers.length === 0 ? (
          <EmptyState>هنوز چاپگری ثبت نشده است. می‌توانید بدون چاپگر هم با «چاپ مرورگر» کار کنید.</EmptyState>
        ) : (
          <div className="space-y-3">
            {printers.map((printer) => (
              <PrinterCard
                key={printer.id}
                printer={printer}
                busy={busy}
                templateOptions={templateOptions}
                onSave={save}
                onDelete={remove}
                onNotice={setNotice}
                onError={setError}
              />
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function DiscoveryList({
  title,
  hint,
  empty,
  rows,
}: {
  title: string;
  hint: string;
  empty: string;
  rows: { key: string; title: string; subtitle: string; tag: string; onUse: () => void }[];
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border/80 p-3">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
      {rows.length === 0 ? (
        <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">{empty}</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {rows.map((row) => (
            <li key={row.key} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground" dir="auto">
                  {row.title}
                </p>
                <p className="truncate text-xs text-muted-foreground" dir="auto">
                  {row.subtitle || row.tag}
                </p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={row.onUse}>
                استفاده
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PrinterForm({
  value,
  onChange,
  onSubmit,
  submitLabel,
  busy,
  templateOptions,
}: {
  value: Draft;
  onChange: (value: Draft) => void;
  onSubmit: (event: React.FormEvent) => void;
  submitLabel: string;
  busy: boolean;
  templateOptions: { value: string; label: string }[];
}) {
  function change<K extends keyof Draft>(key: K, next: Draft[K]) {
    onChange({ ...value, [key]: next });
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-x-4 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="نام چاپگر">
        <input
          className={inputClass}
          value={value.name}
          onChange={(e) => change("name", e.target.value)}
          placeholder="مثلاً چاپگر صندوق"
          required
        />
      </Field>
      <Field label="کاربرد">
        <SearchableSelect
          value={value.kind}
          onChange={(next) => change("kind", next === "kitchen" ? "kitchen" : "receipt")}
          options={[
            { value: "receipt", label: "رسید و فاکتور مشتری" },
            { value: "kitchen", label: "آشپزخانه" },
          ]}
        />
      </Field>
      <Field label="نوع اتصال">
        <SearchableSelect
          value={value.transport}
          onChange={(next) => change("transport", next as PrinterTransport)}
          options={(Object.keys(PRINTER_TRANSPORT_LABELS) as PrinterTransport[]).map((key) => ({
            value: key,
            label: PRINTER_TRANSPORT_LABELS[key],
          }))}
        />
      </Field>

      {value.transport === "network" ? (
        <>
          <Field label="IP شبکه">
            <input
              className={inputClass}
              dir="ltr"
              value={value.ip}
              onChange={(e) => change("ip", e.target.value)}
              placeholder="192.168.1.50"
              required
            />
          </Field>
          <Field label="پورت">
            <PersianNumberInput
              className={inputClass}
              dir="ltr"
              inputMode="numeric"
              grouping={false}
              allowNegative={false}
              value={value.port}
              onChange={(e) => change("port", e.target.value)}
              required
            />
          </Field>
        </>
      ) : null}

      {value.transport === "system" ? (
        <Field label="نام چاپگر در ویندوز" hint="دقیقاً همان نامی که در فهرست بالا آمده است.">
          <input
            className={inputClass}
            dir="auto"
            value={value.systemName}
            onChange={(e) => change("systemName", e.target.value)}
            placeholder="EPSON TM-T20III Receipt"
            required
          />
        </Field>
      ) : null}

      {value.transport === "usb" ? (
        <Field label="مسیر دستگاه" hint="مثلاً USB001 در ویندوز یا /dev/usb/lp0 در لینوکس.">
          <input
            className={inputClass}
            dir="ltr"
            value={value.devicePath}
            onChange={(e) => change("devicePath", e.target.value)}
            placeholder="USB001"
            required
          />
        </Field>
      ) : null}

      {value.transport === "webusb" ? (
        <Field
          label="چاپگر متصل به مرورگر"
          hint="سرور سند را می‌سازد و همین مرورگر آن را از راه WebUSB به چاپگر می‌فرستد — بدون پنجرهٔ چاپ. مخصوص نصب سروری که عامل چاپ ندارد؛ فقط Chrome/Edge و فقط کاغذ حرارتی. اگر چاپ با خطای usb_claim_failed برگشت، درایور ویندوزیِ چاپگر دستگاه را قفل کرده است."
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-foreground" dir="auto">
              {value.usbVendorId
                ? value.usbProductName ||
                  `USB ${value.usbVendorId.toString(16).padStart(4, "0")}:${(value.usbProductId ?? 0)
                    .toString(16)
                    .padStart(4, "0")}`
                : "هنوز چاپگری به مرورگر متصل نشده است."}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void requestWebUsbPrinter().then((result) => {
                  if (!result.ok) return;
                  onChange({
                    ...value,
                    usbVendorId: result.printer.usbVendorId,
                    usbProductId: result.printer.usbProductId,
                    usbSerial: result.printer.usbSerial,
                    usbProductName: result.printer.usbProductName,
                    name: value.name || result.printer.usbProductName || "چاپگر USB",
                  });
                })
              }
            >
              <UsbIcon aria-hidden="true" />
              {value.usbVendorId ? "اتصال دوباره" : "انتخاب چاپگر USB"}
            </Button>
          </div>
        </Field>
      ) : null}

      <Field label="کاغذ" hint={PAPERS[value.paper].hint}>
        <SearchableSelect
          value={value.paper}
          onChange={(next) => change("paper", next as PaperKey)}
          options={PAPER_KEYS.map((key) => ({ value: key, label: PAPERS[key].label }))}
        />
      </Field>
      <Field label="قالب پیش‌فرض این چاپگر">
        <SearchableSelect value={value.templateKey} onChange={(next) => change("templateKey", next)} options={templateOptions} />
      </Field>

      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm sm:col-span-2 lg:col-span-3">
        <label className="flex items-center gap-2">
          <Switch checked={value.isActive} onCheckedChange={(next) => change("isActive", next)} />
          فعال
        </label>
        <label className="flex items-center gap-2">
          <Switch checked={value.isDefault} onCheckedChange={(next) => change("isDefault", next)} />
          پیش‌فرض این کاربرد
        </label>
        {value.kind === "receipt" ? (
          <label className="flex items-center gap-2">
            <Switch checked={value.openDrawer} onCheckedChange={(next) => change("openDrawer", next)} />
            بازکردن کشوی پول پس از چاپ
          </label>
        ) : null}
      </div>

      <div className="sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={busy}>
          {busy ? "در حال ذخیره…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function PrinterCard({
  printer,
  busy,
  templateOptions,
  onSave,
  onDelete,
  onNotice,
  onError,
}: {
  printer: PrinterRow;
  busy: boolean;
  templateOptions: { value: string; label: string }[];
  onSave: (printer: PrinterRow, value: Draft) => Promise<void>;
  onDelete: (printer: PrinterRow) => Promise<void>;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(() => toDraft(printer));
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<"unknown" | "online" | "offline">("unknown");
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    setValue(toDraft(printer));
  }, [printer]);

  async function probe() {
    setTesting(true);
    const result = await probePrinter(connectionOf(value));
    setTesting(false);
    setStatus(result.ok && result.data?.reachable ? "online" : "offline");
    if (!result.ok && result.unreachable) {
      onError("نه عامل چاپ محلی در دسترس است و نه سرور برنامه؛ وضعیت چاپگر قابل بررسی نیست.");
    }
  }

  async function act(action: "print" | "drawer") {
    setTesting(true);
    const connection = connectionOf(value);
    const result = action === "print" ? await testPrint(connection, value.kind) : await kickDrawer(connection);
    setTesting(false);
    if (!result.ok) {
      onError(
        result.unreachable
          ? "هیچ مسیر چاپی در دسترس نیست؛ عامل چاپ را روی دستگاه صندوق اجرا کنید یا اتصال به سرور را بررسی کنید."
          : "فرمان چاپگر با خطا روبه‌رو شد.",
      );
      return;
    }
    onNotice(action === "print" ? "فرمان چاپ آزمایشی ارسال شد." : "فرمان بازشدن کشوی پول ارسال شد.");
  }

  return (
    <div className="rounded-xl border border-border/80 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 p-3">
        <button type="button" onClick={() => setOpen((prev) => !prev)} className="min-w-0 flex-1 rounded-lg px-1 py-1 text-right hover:bg-muted">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-foreground">{printer.name}</span>
            {value.isDefault ? (
              <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[11px] text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200">
                پیش‌فرض
              </span>
            ) : null}
            {!value.isActive ? <span className="text-xs text-muted-foreground">(غیرفعال)</span> : null}
          </span>
          <span className="mt-1 block truncate text-xs text-muted-foreground" dir="auto">
            {PRINTER_TRANSPORT_LABELS[value.transport]} · {describeConnection(printer.connection ?? {})} · {PAPERS[value.paper].label}
          </span>
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {status === "online" ? (
            <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-300">
              <CheckCircle2Icon className="size-4" aria-hidden="true" />
              در دسترس
            </span>
          ) : status === "offline" ? (
            <span className="flex items-center gap-1 text-xs text-red-700 dark:text-red-300">
              <XCircleIcon className="size-4" aria-hidden="true" />
              بی‌پاسخ
            </span>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void probe()} disabled={testing}>
            <PlugZapIcon aria-hidden="true" />
            {testing ? "در حال بررسی…" : "بررسی اتصال"}
          </Button>
        </div>
      </div>

      {open ? (
        <div className="border-t border-border/80 p-3">
          <PrinterForm
            value={value}
            onChange={setValue}
            onSubmit={(event) => {
              event.preventDefault();
              void onSave(printer, value);
            }}
            submitLabel="ذخیرهٔ چاپگر"
            busy={busy}
            templateOptions={templateOptions}
          />
          <div className="mt-3 flex flex-wrap gap-2 border-t border-border/80 pt-3">
            <Button type="button" variant="outline" size="sm" onClick={() => void act("print")} disabled={testing}>
              چاپ آزمایشی
            </Button>
            {value.kind === "receipt" ? (
              <Button type="button" variant="outline" size="sm" onClick={() => void act("drawer")} disabled={testing}>
                آزمایش کشوی پول
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => void onDelete(printer)} disabled={busy}>
              حذف چاپگر
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Windows connector, always on screen — not only while the local agent is
 * silent.
 *
 * It used to render only when `localAgentOnline` was false, which made it
 * invisible in exactly two situations people asked about: a cloud deployment
 * whose *server* answered the health probe (`via: "server"` still counts as
 * "online" for the section as a whole, so the download vanished while the
 * cashier's Windows queues were still unreachable), and a till whose connector
 * was already installed but needed reinstalling after an update or a new
 * tenant origin. A download nobody can find is the same as a download that
 * does not exist, so the card is permanent: the heading states the current
 * state, and the button is always there.
 */
function WindowsConnectorCard({ localAgentOnline }: { localAgentOnline: boolean }) {
  return (
    <SectionCard
      title="رابط چاپ ویندوز"
      description={
        localAgentOnline
          ? "رابط چاپ روی همین کامپیوتر در حال اجراست؛ چاپگرهای نصب‌شدهٔ ویندوز خوانده می‌شوند."
          : "برای چاپ روی چاپگر USB یا چاپگر نصب‌شده در Windows، رابط چاپ را یک‌بار روی همین کامپیوتر نصب کنید."
      }
      actions={
        <Button asChild variant={localAgentOnline ? "outline" : "default"}>
          <a href="/api/print/windows-agent-installer" download>
            <DownloadIcon aria-hidden="true" />
            {localAgentOnline ? "نصب دوبارهٔ رابط چاپ" : "دانلود و نصب رابط چاپ ویندوز"}
          </a>
        </Button>
      }
    >
      <div className="space-y-2 text-sm leading-6 text-muted-foreground">
        <p>
          فایل دانلودشده را باز کنید و تأیید Windows را بزنید؛ نصب و راه‌اندازی کاملاً خودکار است، به Node.js یا دستور
          PowerShell نیازی نیست و از ورود‌های بعدی Windows هم خودکار اجرا می‌شود.
        </p>
        <p>
          پس از پیام موفقیت به همین صفحه برگردید، «بررسی دوباره» را بزنید و اگر مرورگر اجازهٔ Apps on device یا Local
          network access خواست، Allow را انتخاب کنید.
        </p>
        {localAgentOnline ? null : (
          <p className="text-xs">
            اگر برنامه روی سرور ابری اجرا می‌شود، «چاپگرهای ویندوز» بدون این رابط فهرست چاپگرهای سرور را نشان می‌دهد، نه
            چاپگرهای این کامپیوتر.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
