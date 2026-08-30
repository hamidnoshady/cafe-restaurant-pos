"use client";

/**
 * Phase 37 — the super-admin's gateway console.
 *
 * This page exists because the gateway is a *deployment-wide* component: the
 * address, the admin credential, the failover chain and the default budgets
 * belong to the platform, not to any business. Per-business keys live on the
 * same page because provisioning one is the action that makes the rest mean
 * anything — without a per-business key there is no per-business spend inside
 * the gateway at all.
 *
 * Two boundaries are held deliberately. The gateway's admin key is typed but
 * never displayed (only acknowledged, like the provider key on /platform/ai),
 * and a business's virtual key is never rendered either — the console shows
 * whether one exists and what it has spent.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatPersianNumber } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2Icon } from "lucide-react";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, useCan } from "../../ui";

interface GatewayConfig {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  fallbackModels: string[];
  routingStrategy: string;
  virtualKeysEnabled: boolean;
  allowBusinessModels: boolean;
  publishedModels: string[];
  defaultMaxBudgetUsd: number | null;
  defaultBudgetDuration: string;
  defaultTpmLimit: number | null;
  defaultRpmLimit: number | null;
  usdRialRate: number | null;
  gatewayCostingEnabled: boolean;
  promptBindings: Record<string, string>;
  mcpEnabled: boolean;
  mcpServers: { name: string; label: string; url: string }[];
  hasMasterKey: boolean;
}

interface BusinessGateway {
  businessId: string;
  keyAlias: string | null;
  modelOverride: string | null;
  maxBudgetUsd: number | null;
  budgetDuration: string | null;
  tpmLimit: number | null;
  rpmLimit: number | null;
  spendUsd: number;
  syncedAt: string | null;
  syncError: string | null;
  hasVirtualKey: boolean;
  effectiveModel: string;
}

interface GatewayStatus {
  ok: boolean;
  latencyMs: number | null;
  models: string[];
  error: string | null;
}

interface GatewayData {
  gateway: GatewayConfig | null;
  provider: string;
  platformModel: string;
  platformBaseUrl: string;
  providerIsGateway: boolean;
  active: boolean;
  status: GatewayStatus | null;
  gateways: BusinessGateway[];
  error?: string;
}

interface BusinessSummary {
  businessId: string;
  businessName: string;
}

const ROUTING_OPTIONS = [
  { value: "simple-shuffle", label: "simple-shuffle — توزیع ساده" },
  { value: "least-busy", label: "least-busy — کم‌ترین بار" },
  { value: "usage-based-router", label: "usage-based-router — بر پایهٔ مصرف" },
  { value: "latency-based-routing", label: "latency-based-routing — کم‌ترین تأخیر" },
  { value: "cost-based-routing", label: "cost-based-routing — کم‌ترین هزینه" },
];

const DURATION_OPTIONS = [
  { value: "1d", label: "روزانه (1d)" },
  { value: "7d", label: "هفتگی (7d)" },
  { value: "30d", label: "ماهانه (30d)" },
];

/** Phase 38b — the surfaces a gateway prompt (a «مهارت») can be bound to. */
const PROMPT_SURFACES = [
  { value: "wizard", label: "ویزارد راه‌اندازی" },
  { value: "dashboard", label: "داشبورد" },
  { value: "floor", label: "سالن" },
  { value: "proactive", label: "پیام‌های پیشنهادی" },
  { value: "autopilot", label: "خلبان خودکار" },
  { value: "platform", label: "پشتیبانی پلتفرم" },
];

interface GatewayUsageEntry {
  day: string;
  keyAlias: string;
  businessId: string | null;
  model: string;
  spendUsd: number;
  spendRial: number | null;
  promptTokens: number;
  completionTokens: number;
  apiRequests: number;
}

interface GatewayUsageData {
  days: number;
  usage: GatewayUsageEntry[];
  totals: {
    spendUsd: number;
    spendRial: number | null;
    promptTokens: number;
    completionTokens: number;
    apiRequests: number;
  };
  gatewayCosting: { enabled: boolean; usdRialRate: number | null };
  error?: string;
}

function listText(values: string[]): string {
  return values.join("\n");
}

function parseList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function numericOrNull(value: string): number | null {
  const n = Number(value.replace(/[٬,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `name | label | url`, one server per line — same shape the service stores. */
function parseMcpServers(text: string): { name: string; label: string; url: string }[] {
  const servers: { name: string; label: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    const [name, label, url] = line.split("|").map((part) => part.trim());
    const slug = (name ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!slug || !url || seen.has(slug)) continue;
    seen.add(slug);
    servers.push({ name: slug, label: label || slug, url });
  }
  return servers;
}

function mcpServersToText(servers: { name: string; label: string; url: string }[]): string {
  return servers.map((server) => `${server.name} | ${server.label} | ${server.url}`).join("\n");
}

function fmtUsd(value: number): string {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return formatPersianNumber(rounded);
}

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function PlatformAiGatewayPage() {
  const can = useCan();
  const [data, setData] = useState<GatewayData | null>(null);
  const [businesses, setBusinesses] = useState<BusinessSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<GatewayConfig | null>(null);
  const [masterKey, setMasterKey] = useState("");
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [publishedText, setPublishedText] = useState("");
  const [promptBindings, setPromptBindings] = useState<Record<string, string>>({});
  const [mcpText, setMcpText] = useState("");
  const [usage, setUsage] = useState<GatewayUsageData | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [gatewayResult, businessResult] = await Promise.all([
      api<GatewayData>("/api/platform/ai/gateway"),
      api<{ businesses: BusinessSummary[] }>("/api/platform/ai"),
    ]);
    if (!gatewayResult.ok) {
      setError(gatewayResult.data.error ?? "خواندن تنظیمات دروازه ممکن نشد.");
      setLoading(false);
      return;
    }
    setData(gatewayResult.data);
    setDraft(gatewayResult.data.gateway);
    if (gatewayResult.data.gateway) {
      const config = gatewayResult.data.gateway;
      setPromptBindings({ ...config.promptBindings });
      setMcpText(mcpServersToText(config.mcpServers));
    }
    if (businessResult.ok) setBusinesses(businessResult.data.businesses ?? []);
    setSelectedBusinessId((current) =>
      current && (businessResult.data.businesses ?? []).some((b) => b.businessId === current) ? current : "",
    );
    setLoading(false);
  }, []);

  const loadUsage = useCallback(async () => {
    const result = await api<GatewayUsageData>("/api/platform/ai/gateway/usage?days=30");
    setUsage(result.ok ? result.data : null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  async function syncUsage() {
    setBusy("usage-sync");
    setError("");
    setNotice("");
    const result = await api<{ sync: { ok: boolean; entries: number; rows: number; error: string | null }; error?: string }>(
      "/api/platform/ai/gateway/usage",
      { method: "POST", body: JSON.stringify({ days: 7 }) },
    );
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "همگام‌سازی مصرف ممکن نشد.");
      return;
    }
    setNotice(
      result.data.sync.ok
        ? `مصرف به‌روزرسانی شد (${formatPersianNumber(result.data.sync.entries)} رکورد از دروازه خوانده شد).`
        : `همگام‌سازی ناموفق بود: ${result.data.sync.error ?? "خطای نامشخص"}`,
    );
    await loadUsage();
  }

  const selectedName = useMemo(
    () => businesses.find((business) => business.businessId === selectedBusinessId)?.businessName ?? "",
    [businesses, selectedBusinessId],
  );

  const selectedRow = useMemo(
    () => data?.gateways.find((row) => row.businessId === selectedBusinessId) ?? null,
    [data?.gateways, selectedBusinessId],
  );

  async function write(body: Record<string, unknown>, key: string, method: "PUT" | "POST" = "POST") {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await api<{ error?: string }>("/api/platform/ai/gateway", {
      method,
      body: JSON.stringify(body),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "انجام عملیات ممکن نشد.");
      return false;
    }
    setNotice("تغییرات ذخیره شد.");
    await load();
    return true;
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    await write(
      {
        action: "config",
        gateway: {
          ...draft,
          fallbackModels: parseList(fallbackText),
          publishedModels: parseList(publishedText),
          promptBindings: Object.fromEntries(
            Object.entries(promptBindings).filter(([, value]) => value.trim()),
          ),
          mcpEnabled: draft.mcpEnabled,
          mcpServers: parseMcpServers(mcpText),
          masterKey: masterKey || undefined,
        },
      },
      "config",
      "PUT",
    );
    setMasterKey("");
  }

  async function probe() {
    if (!draft) return;
    setBusy("probe");
    setError("");
    setNotice("");
    const result = await api<{ status: GatewayStatus; error?: string }>("/api/platform/ai/gateway", {
      method: "PUT",
      body: JSON.stringify({
        action: "probe",
        gateway: {
          ...draft,
          fallbackModels: parseList(fallbackText),
          publishedModels: parseList(publishedText),
          masterKey: masterKey || undefined,
        },
      }),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ?? "بررسی ارتباط ممکن نشد.");
      return;
    }
    setData((current) => (current ? { ...current, status: result.data.status } : current));
  }

  useEffect(() => {
    if (draft) {
      setFallbackText(listText(draft.fallbackModels));
      setPublishedText(listText(draft.publishedModels));
    }
  }, [draft]);

  if (loading) {
    return <p className="text-sm text-white/50">در حال بارگذاری تنظیمات دروازه…</p>;
  }

  const status = data?.status;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header>
        <h1 className="text-xl font-bold">دروازهٔ مدل (LiteLLM)</h1>
        <p className="mt-1 text-sm text-white/50">
          یک نشانی OpenAI-سازگار در برابر چند ارائه‌دهنده: کلید مجازی برای هر کسب‌وکار، سقف هزینه، زنجیرهٔ
          جایگزین و نام مستعار مدل. مدیریت در <a className="underline" href="/platform/ai">هوش مصنوعی</a> است؛
          اینجا فقط تنظیمات دروازه است.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card title="وضعیت">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-white/50">ارائه‌دهندهٔ فعلی</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.provider ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-white/50">دروازه فعال است</dt>
            <dd className="mt-1 font-medium">{data?.active ? "بله" : "خیر"}</dd>
          </div>
          <div>
            <dt className="text-white/50">مدل پلتفرم</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.platformModel ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-white/50">نشانی</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.platformBaseUrl ?? "—"}
            </dd>
          </div>
        </dl>
        {!data?.providerIsGateway ? (
          <InfoBox>
            ارائه‌دهندهٔ فعلی یک دروازه نیست. برای استفاده از این بخش، در صفحهٔ مدیریت هوش مصنوعی گزینهٔ
            «LiteLLM» را انتخاب کنید.
          </InfoBox>
        ) : null}
        {status ? (
          <div className="mt-3 rounded-lg border border-white/10 bg-white/2 p-3 text-sm">
            {status.ok ? (
              <p>
                ارتباط برقرار است
                {status.latencyMs !== null ? ` · ${formatPersianNumber(status.latencyMs)} میلی‌ثانیه` : ""}
                {status.models.length > 0
                  ? ` · ${formatPersianNumber(status.models.length)} مدل`
                  : " · فهرست مدل‌ها در دسترس نبود"}
              </p>
            ) : (
              <p className="text-rose-300">{status.error}</p>
            )}
            {status.models.length > 0 ? (
              <p className="mt-2 text-xs text-white/50" dir="ltr">
                {status.models.join("، ")}
              </p>
            ) : null}
          </div>
        ) : null}
        {can("ai.config.manage") ? (
          <div className="mt-3">
            <Button type="button" variant="ghost" onClick={() => void probe()} disabled={Boolean(busy)}>
              {busy === "probe" ? <Loader2Icon className="animate-spin" /> : "بررسی ارتباط"}
            </Button>
          </div>
        ) : null}
      </Card>

      {can("ai.config.manage") && draft ? (
        <Card title="تنظیمات دروازه">
          <p className="mb-4 text-sm text-white/50">
            این نشانی برای همهٔ کسب‌وکارهاست. کلید مدیر فقط برای صدور کلید مجازی استفاده می‌شود و هرگز به
            داشبورد کسب‌وکار ارسال نمی‌شود. بودجه‌ها به دلار و فقط یک سقف ایمنی‌اند؛ مبلغی که کسب‌وکار
            می‌پردازد همچنان همان اعتبار ریالی است.
          </p>
          <form onSubmit={saveConfig} className="grid gap-4 lg:grid-cols-2">
            {data?.providerIsGateway ? (
              <Field
                label="نشانی دروازه"
                hint="از اتصال ارائه‌دهنده گرفته می‌شود؛ برای تغییر آن به صفحهٔ مدیریت هوش مصنوعی بروید. یک نشانی بیشتر وجود ندارد، وگرنه گفت‌وگو به میزبان و صدور کلید به میزبان دیگری می‌رفت."
              >
                <input className={inputClass} dir="ltr" value={draft.baseUrl} readOnly />
              </Field>
            ) : (
              <Field label="نشانی دروازه">
                <input
                  className={inputClass}
                  dir="ltr"
                  value={draft.baseUrl}
                  onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
                />
              </Field>
            )}
            <Field label="کلید مدیر" hint={draft.hasMasterKey ? "کلید ذخیره شده است؛ برای حفظ آن خالی بگذارید." : "کلید مدیر دروازه را وارد کنید."}>
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                value={masterKey}
                onChange={(event) => setMasterKey(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field label="نام مستعار مدل گفت‌وگو" hint="خالی یعنی همان مدل تنظیم‌شدهٔ پلتفرم.">
              <input
                className={inputClass}
                dir="ltr"
                value={draft.chatModel}
                onChange={(event) => setDraft({ ...draft, chatModel: event.target.value })}
              />
            </Field>
            <Field label="نام مستعار مدل بردارسازی" hint="می‌تواند از ارائه‌دهندهٔ دیگری بیاید؛ با این کار جست‌وجوی دانش روی دروازه‌هایی که فقط مدل گفت‌وگو دارند هم کار می‌کند.">
              <input
                className={inputClass}
                dir="ltr"
                value={draft.embeddingModel}
                onChange={(event) => setDraft({ ...draft, embeddingModel: event.target.value })}
              />
            </Field>
            <div className="lg:col-span-2">
              <Field label="زنجیرهٔ جایگزین" hint="هر سطر یا کاما یک مدل؛ به ترتیب پس از خطای مدل اصلی امتحان می‌شود.">
                <textarea
                  className={inputClass}
                  dir="ltr"
                  rows={3}
                  value={fallbackText}
                  onChange={(event) => setFallbackText(event.target.value)}
                />
              </Field>
            </div>
            <Field label="روش توزیع">
              <SearchableSelect
                className={inputClass}
                value={draft.routingStrategy}
                onChange={(value) => setDraft({ ...draft, routingStrategy: value })}
                options={ROUTING_OPTIONS}
              />
            </Field>
            <Field label="بودجهٔ پیش‌فرض هر کلید (دلار)">
              <PersianNumberInput
                className={inputClass}
                type="number"
                min="0"
                value={draft.defaultMaxBudgetUsd ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultMaxBudgetUsd: numericOrNull(event.target.value) })}
              />
            </Field>
            <Field label="دورهٔ بودجهٔ پیش‌فرض">
              <SearchableSelect
                className={inputClass}
                value={draft.defaultBudgetDuration}
                onChange={(value) => setDraft({ ...draft, defaultBudgetDuration: value })}
                options={DURATION_OPTIONS}
              />
            </Field>
            <Field label="سقف پیش‌فرض توکن در دقیقه">
              <PersianNumberInput
                className={inputClass}
                type="number"
                min="0"
                value={draft.defaultTpmLimit ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultTpmLimit: numericOrNull(event.target.value) })}
              />
            </Field>
            <Field label="سقف پیش‌فرض درخواست در دقیقه">
              <PersianNumberInput
                className={inputClass}
                type="number"
                min="0"
                value={draft.defaultRpmLimit ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultRpmLimit: numericOrNull(event.target.value) })}
              />
            </Field>
            <Field
              label="نرخ تبدیل دلار به ریال"
              hint="مبنای محاسبهٔ هزینهٔ واقعی از گزارش خود دروازه (دلار) به ریال. بدون این نرخ، تسویهٔ هزینه‌ای ممکن نیست."
            >
              <PersianNumberInput
                className={inputClass}
                type="number"
                min="0"
                value={draft.usdRialRate ?? ""}
                onChange={(event) => setDraft({ ...draft, usdRialRate: numericOrNull(event.target.value) })}
              />
            </Field>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                فعال بودن دروازه
              </label>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={draft.virtualKeysEnabled}
                  onChange={(event) => setDraft({ ...draft, virtualKeysEnabled: event.target.checked })}
                />
                صدور کلید مجازی برای هر کسب‌وکار
              </label>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={draft.allowBusinessModels}
                  onChange={(event) => setDraft({ ...draft, allowBusinessModels: event.target.checked })}
                />
                اجازهٔ انتخاب مدل به کسب‌وکار
              </label>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={draft.gatewayCostingEnabled}
                  onChange={(event) => setDraft({ ...draft, gatewayCostingEnabled: event.target.checked })}
                />
                محاسبهٔ هزینه از گزارش خود دروازه (به‌جای نرخ دستی توکن)
              </label>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={draft.mcpEnabled}
                  onChange={(event) => setDraft({ ...draft, mcpEnabled: event.target.checked })}
                />
                ابزارهای MCP از راه دروازه
              </label>
            </div>
            {draft.gatewayCostingEnabled && !draft.usdRialRate ? (
              <div className="lg:col-span-2">
                <ErrorBox>برای محاسبهٔ هزینه از گزارش دروازه، ابتدا نرخ تبدیل دلار به ریال را وارد کنید.</ErrorBox>
              </div>
            ) : null}
            <div className="lg:col-span-2 border-t border-white/10 pt-4">
              <p className="mb-3 text-sm font-medium">مهارت‌ها — پرامپت‌های دروازه</p>
              <p className="mb-3 text-xs text-white/50">
                هر سطح گفت‌وگو می‌تواند به یک پرامپت ثبت‌شده در دروازه (پوشهٔ prompts در LiteLLM) وصل شود.
                پرامپتِ دروازه جای پیام سیستمی برنامه را می‌گیرد؛ متن دستورهای سیستم به‌عنوان متغیر
                <span dir="ltr"> {"{{system_context}}"} </span>
                همراه بقیهٔ متغیرها (نام کسب‌وکار، نام کاربر، mode) ارسال می‌شود — قالبی که این متغیر را حذف کند،
                قواعد تأیید پیش از نوشتن را هم حذف کرده است.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {PROMPT_SURFACES.map((surface) => (
                  <Field key={surface.value} label={surface.label}>
                    <input
                      className={inputClass}
                      dir="ltr"
                      value={promptBindings[surface.value] ?? ""}
                      placeholder="prompt_id"
                      onChange={(event) =>
                        setPromptBindings({ ...promptBindings, [surface.value]: event.target.value })
                      }
                    />
                  </Field>
                ))}
              </div>
            </div>
            <div className="lg:col-span-2 border-t border-white/10 pt-4">
              <Field
                label="سرورهای MCP دروازه"
                hint="هر سطر: name | برچسب | نشانی. این سرورها در هر نوبت گفت‌وگو به مدل معرفی می‌شوند و دروازه خودشان اجرایشان می‌کند؛ از جمله اتصال‌دهندهٔ MCP همین سامانه (‎/api/mcp)."
              >
                <textarea
                  className={inputClass}
                  dir="ltr"
                  rows={3}
                  placeholder={"pos-mcp | اتصال‌دهندهٔ POS | https://pos.example.ir/api/mcp"}
                  value={mcpText}
                  onChange={(event) => setMcpText(event.target.value)}
                />
              </Field>
            </div>
            {draft.allowBusinessModels ? (
              <div className="lg:col-span-2">
                <Field label="مدل‌های قابل انتخاب" hint="یک سطر برای هر مدل. فقط همین‌ها به کسب‌وکار پیشنهاد می‌شود.">
                  <textarea
                    className={inputClass}
                    dir="ltr"
                    rows={3}
                    value={publishedText}
                    onChange={(event) => setPublishedText(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}
            <div className="lg:col-span-2">
              <Button type="submit" disabled={busy === "config"}>
                {busy === "config" ? "در حال ذخیره…" : "ذخیره تنظیمات دروازه"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {can("ai.read") ? (
        <Card title="مصرف از دید دروازه — ۳۰ روز گذشته">
          <p className="mb-3 text-sm text-white/50">
            جمع‌بندی روزانهٔ گزارش‌های مصرف خود دروازه (به تفکیک کلید مجازی و مدل). ارقام دلاری تشخیصی‌اند؛
            مبلغ ریالیِ محاسبه‌شده با نرخ تبدیل، تنها برای مقایسه با دفتر اعتبار است و جای آن را نمی‌گیرد.
            روزها بر پایهٔ UTC است — دروازه از روز کاری شعبه‌ها بی‌خبر است.
          </p>
          {can("ai.config.manage") ? (
            <div className="mb-4">
              <Button onClick={() => void syncUsage()} disabled={Boolean(busy)}>
                {busy === "usage-sync" ? <Loader2Icon className="animate-spin" /> : "همگام‌سازی مصرف از دروازه"}
              </Button>
            </div>
          ) : null}
          {!usage ? (
            <p className="text-sm text-white/40">مصرفی خوانده نشده است؛ دکمهٔ همگام‌سازی را بزنید.</p>
          ) : (
            <>
              <div className="mb-4 grid gap-2 text-sm sm:grid-cols-4">
                <p>
                  هزینه: <strong>{fmtUsd(usage.totals.spendUsd)}</strong> دلار
                  {usage.totals.spendRial !== null
                    ? ` (≈ ${formatPersianNumber(usage.totals.spendRial)} ریال)`
                    : ""}
                </p>
                <p>درخواست: {formatPersianNumber(usage.totals.apiRequests)}</p>
                <p>توکن ورودی: {formatPersianNumber(usage.totals.promptTokens)}</p>
                <p>توکن خروجی: {formatPersianNumber(usage.totals.completionTokens)}</p>
              </div>
              {usage.usage.length === 0 ? (
                <p className="text-sm text-white/40">برای این بازه رکوردی ثبت نشده است.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-right text-sm">
                    <thead className="text-xs text-white/50">
                      <tr>
                        <th className="px-2 py-1 font-medium">روز (UTC)</th>
                        <th className="px-2 py-1 font-medium">کلید</th>
                        <th className="px-2 py-1 font-medium">مدل</th>
                        <th className="px-2 py-1 font-medium">درخواست</th>
                        <th className="px-2 py-1 font-medium">توکن‌ها</th>
                        <th className="px-2 py-1 font-medium">هزینه</th>
                      </tr>
                    </thead>
                    <tbody>
                      {usage.usage.slice(0, 100).map((row) => (
                        <tr key={`${row.day}|${row.keyAlias}|${row.model}`} className="border-t border-white/5">
                          <td className="px-2 py-1" dir="ltr">{row.day}</td>
                          <td className="px-2 py-1" dir="ltr">{row.keyAlias}</td>
                          <td className="px-2 py-1" dir="ltr">{row.model}</td>
                          <td className="px-2 py-1">{formatPersianNumber(row.apiRequests)}</td>
                          <td className="px-2 py-1">
                            {formatPersianNumber(row.promptTokens)} / {formatPersianNumber(row.completionTokens)}
                          </td>
                          <td className="px-2 py-1">
                            {fmtUsd(row.spendUsd)} دلار
                            {row.spendRial !== null ? ` · ${formatPersianNumber(row.spendRial)} ریال` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {usage.usage.length > 100 ? (
                    <p className="mt-2 text-xs text-white/40">
                      {formatPersianNumber(usage.usage.length - 100)} سطر دیگر نمایش داده نشده است.
                    </p>
                  ) : null}
                </div>
              )}
              {usage.gatewayCosting.enabled ? (
                <p className="mt-3 text-xs text-white/50">
                  محاسبهٔ هزینه از گزارش دروازه فعال است؛ نرخ تبدیل:
                  {" "}
                  {formatPersianNumber(usage.gatewayCosting.usdRialRate ?? 0)} ریال به ازای هر دلار.
                </p>
              ) : (
                <p className="mt-3 text-xs text-white/50">
                  محاسبهٔ هزینه از گزارش دروازه خاموش است؛ تسویه با نرخ‌های دستی توکن انجام می‌شود.
                </p>
              )}
            </>
          )}
        </Card>
      ) : null}

      {can("ai.credits.manage") ? (
        <Card title="کلید مجازی — هر کسب‌وکار">
          <p className="mb-3 text-sm text-white/50">
            کلید مجازی همان چیزی است که مصرف را در دروازه به نام کسب‌وکار ثبت می‌کند. بدون آن، همهٔ
            کسب‌وکارها روی یک شمارنده مشترک می‌نشینند.
          </p>
          <div className="mb-4">
            <Field label="کسب‌وکار">
              <SearchableSelect
                value={selectedBusinessId}
                onChange={setSelectedBusinessId}
                options={businesses.map((business) => ({ value: business.businessId, label: business.businessName }))}
              />
            </Field>
          </div>

          {selectedBusinessId ? (
            <div className="space-y-4 border-t border-white/10 pt-4">
              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <p>
                  مدل مؤثر:{" "}
                  <strong dir="ltr" className="font-medium">
                    {selectedRow?.effectiveModel ?? data?.platformModel ?? "—"}
                  </strong>
                </p>
                <p>کلید مجازی: {selectedRow?.hasVirtualKey ? "دارد" : "ندارد"}</p>
                <p>
                  مصرف گزارش‌شده: {formatPersianNumber(Math.round((selectedRow?.spendUsd ?? 0) * 100) / 100)} دلار
                </p>
                <p>نام مستعار: <span dir="ltr">{selectedRow?.keyAlias ?? "—"}</span></p>
                <p>آخرین همگام‌سازی: {fmtDate(selectedRow?.syncedAt ?? null)}</p>
                <p>
                  سقف‌ها:{" "}
                  {selectedRow?.maxBudgetUsd ? `${formatPersianNumber(selectedRow.maxBudgetUsd)} دلار` : "بدون سقف"}
                  {selectedRow?.tpmLimit ? ` · ${formatPersianNumber(selectedRow.tpmLimit)} توکن/دقیقه` : ""}
                </p>
              </div>
              {selectedRow?.syncError ? (
                <ErrorBox>{selectedRow.syncError}</ErrorBox>
              ) : null}

              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => void write({ action: "sync_key", businessId: selectedBusinessId }, "sync")}
                  disabled={Boolean(busy)}
                >
                  {busy === "sync" ? <Loader2Icon className="animate-spin" /> : "صدور / به‌روزرسانی کلید"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => void write({ action: "refresh_spend", businessId: selectedBusinessId }, "spend")}
                  disabled={Boolean(busy) || !selectedRow?.hasVirtualKey}
                >
                  {busy === "spend" ? <Loader2Icon className="animate-spin" /> : "به‌روزرسانی مصرف"}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => void write({ action: "revoke_key", businessId: selectedBusinessId }, "revoke")}
                  disabled={Boolean(busy) || !selectedRow?.hasVirtualKey}
                >
                  {busy === "revoke" ? <Loader2Icon className="animate-spin" /> : "لغو کلید"}
                </Button>
              </div>

              {draft?.allowBusinessModels && draft.publishedModels.length > 0 ? (
                <div className="grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
                  <Field label={`مدل اختصاصی ${selectedName}`}>
                    <SearchableSelect
                      value={selectedRow?.modelOverride ?? ""}
                      onChange={(value) =>
                        void write(
                          { action: "business", businessId: selectedBusinessId, modelOverride: value || null },
                          "model",
                        )
                      }
                      options={[
                        { value: "", label: "پیش‌فرض پلتفرم" },
                        ...draft.publishedModels.map((model) => ({ value: model, label: model })),
                      ]}
                    />
                  </Field>
                </div>
              ) : null}
              <p className="text-xs text-white/40">
                بودجه و سقف نرخ را هنگام صدور کلید، از مقادیر پیش‌فرض بالا می‌گیرد.
              </p>
            </div>
          ) : (
            <p className="text-sm text-white/40">یک کسب‌وکار را انتخاب کنید.</p>
          )}
        </Card>
      ) : null}

      <Card title="همهٔ کسب‌وکارها">
        {!data?.gateways.length ? (
          <p className="text-sm text-white/40">هنوز کلیدی برای کسب‌وکاری صادر نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {data.gateways.map((row) => (
              <li
                key={row.businessId}
                className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/2 p-3 text-sm md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <p className="font-medium" dir="ltr">
                    {row.keyAlias ?? row.businessId}
                  </p>
                  <p className="mt-1 text-xs text-white/50">
                    مدل: <span dir="ltr">{row.effectiveModel}</span>
                  </p>
                </div>
                <div className="text-xs text-white/60 md:text-right">
                  <p>مصرف: {formatPersianNumber(Math.round(row.spendUsd * 100) / 100)} دلار</p>
                  {row.syncError ? <p className="text-rose-300">{row.syncError}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
