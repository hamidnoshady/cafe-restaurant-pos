"use client";

/**
 * The super-admin's AI settings — LiteLLM, and only LiteLLM.
 *
 * This single page manages the platform-wide LiteLLM gateway: the master key,
 * model aliases, routing, budgets, and per-business/per-branch virtual keys
 * and model overrides. Provider costing, prompt management, subscriptions and
 * credit handling are deliberately not part of this console anymore.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatPersianNumber } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Loader2Icon } from "lucide-react";
import { api, Button, Card, ErrorBox, Field, InfoBox, inputClass, useCan } from "../ui";

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
  mcpEnabled: boolean;
  mcpServers: { name: string; label: string; url: string }[];
  hasMasterKey: boolean;
}

interface LocationSummary {
  id: string;
  businessId: string;
  name: string;
}

interface BusinessGateway {
  businessId: string;
  locationId: string | null;
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
  /** The strategy the proxy reports it is running, when it reports one. */
  proxyRoutingStrategy: string | null;
  /** The strategy stored here differs from the one the proxy is running. */
  routingMismatch: boolean;
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
  businesses: BusinessSummary[];
  locations: LocationSummary[];
  error?: string;
}

interface BusinessSummary {
  businessId: string;
  businessName: string;
}

/**
 * The routing strategies the LiteLLM proxy implements, mirrored from
 * `GATEWAY_ROUTING_STRATEGIES` in `src/lib/ai-gateway.ts` (which mirrors the
 * proxy's own vocabulary). A value the proxy does not know is ignored without
 * an error, so the console must never offer one.
 */
const ROUTING_OPTIONS = [
  { value: "simple-shuffle", label: "simple-shuffle — توزیع وزنی (پیش‌فرض و پیشنهادی)" },
  { value: "least-busy", label: "least-busy — کم‌ترین درخواست در جریان" },
  { value: "latency-based-routing", label: "latency-based-routing — کم‌ترین تأخیر" },
  { value: "cost-based-routing", label: "cost-based-routing — کم‌ترین هزینه (ناهمگام)" },
  { value: "usage-based-routing-v2", label: "usage-based-routing-v2 — بر پایهٔ مصرف TPM (ناهمگام)" },
  { value: "usage-based-routing", label: "usage-based-routing — نسخهٔ قدیمی (منسوخ)" },
  { value: "provider-budget-routing", label: "provider-budget-routing — بر پایهٔ بودجهٔ ارائه‌دهنده" },
];

const DURATION_OPTIONS = [
  { value: "1d", label: "روزانه (1d)" },
  { value: "7d", label: "هفتگی (7d)" },
  { value: "30d", label: "ماهانه (30d)" },
];

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

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

export default function PlatformAiPage() {
  const can = useCan();
  const [data, setData] = useState<GatewayData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<GatewayConfig | null>(null);
  const [masterKey, setMasterKey] = useState("");
  const [selectedBusinessId, setSelectedBusinessId] = useState("");
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [fallbackText, setFallbackText] = useState("");
  const [publishedText, setPublishedText] = useState("");
  const [mcpText, setMcpText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api<GatewayData>("/api/platform/ai/gateway");
    if (!result.ok) {
      setError(result.data.error ?? "خواندن تنظیمات دروازه ممکن نشد.");
      setLoading(false);
      return;
    }
    setData(result.data);
    setDraft(result.data.gateway);
    if (result.data.gateway) {
      setMcpText(mcpServersToText(result.data.gateway.mcpServers));
    }
    setSelectedBusinessId((current) =>
      current && (result.data.businesses ?? []).some((b) => b.businessId === current) ? current : "",
    );
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedName = useMemo(
    () =>
      (data?.businesses ?? []).find((business) => business.businessId === selectedBusinessId)?.businessName ?? "",
    [data?.businesses, selectedBusinessId],
  );

  const businessLocations = useMemo(
    () => (data?.locations ?? []).filter((loc) => loc.businessId === selectedBusinessId),
    [data?.locations, selectedBusinessId],
  );

  const selectedRow = useMemo(() => {
    if (!data?.gateways || !selectedBusinessId) return null;
    const loc = selectedLocationId || null;
    return (
      data.gateways.find((row) => row.businessId === selectedBusinessId && row.locationId === loc) ?? null
    );
  }, [data?.gateways, selectedBusinessId, selectedLocationId]);

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
        <h1 className="text-xl font-bold">تنظیمات هوش مصنوعی (LiteLLM)</h1>
        <p className="mt-1 text-sm text-white/50">
          ارائه‌دهندهٔ واحد و یکپارچهٔ هوش مصنوعی: نشانی و کلید مدیر، نام مستعار مدل‌ها، زنجیرهٔ جایگزین،
          سقف بودجه و کلیدهای مجازی کسب‌وکارها و شعبه‌ها و ابزارهای MCP.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <Card title="وضعیت">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-white/50">ارائه‌دهنده</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              LiteLLM (دروازهٔ یکپارچه)
            </dd>
          </div>
          <div>
            <dt className="text-white/50">دروازه فعال است</dt>
            <dd className="mt-1 font-medium">{data?.active ? "بله" : "خیر"}</dd>
          </div>
          <div>
            <dt className="text-white/50">مدل پیش‌فرض پلتفرم</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.platformModel ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-white/50">نشانی Base URL</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.platformBaseUrl ?? "—"}
            </dd>
          </div>
        </dl>
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
            {status.ok && status.proxyRoutingStrategy ? (
              <p className="mt-2 text-xs">
                <span className="text-white/50">روش توزیع واقعی دروازه: </span>
                <span dir="ltr" className={status.routingMismatch ? "text-amber-300" : "text-white/80"}>
                  {status.proxyRoutingStrategy}
                </span>
                {status.routingMismatch ? (
                  <span className="text-amber-300">
                    {" "}
                    — با مقدار ذخیره‌شدهٔ این صفحه یکی نیست؛ این مقدار از راه API تغییر نمی‌کند و باید در
                    config.yaml اصلاح شود.
                  </span>
                ) : null}
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
            داشبورد کسب‌وکار ارسال نمی‌شود.
          </p>
          <form onSubmit={saveConfig} className="grid gap-4 lg:grid-cols-2">
            <Field label="نشانی دروازه">
              <input
                className={inputClass}
                dir="ltr"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </Field>
            <Field label="کلید مدیر (Master Key)" hint={draft.hasMasterKey ? "کلید ذخیره شده است؛ برای حفظ آن خالی بگذارید." : "کلید مدیر دروازه را وارد کنید."}>
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                value={masterKey}
                onChange={(event) => setMasterKey(event.target.value)}
                autoComplete="off"
              />
            </Field>
            <Field
              label="نام مستعار مدل گفت‌وگو"
              hint="یکی از نام‌های model_list دروازه (مثلاً pos-chat)؛ نام مدل واقعی ارائه‌دهنده اینجا نوشته نمی‌شود. خالی یعنی همان مدل تنظیم‌شدهٔ پلتفرم."
            >
              <input
                className={inputClass}
                dir="ltr"
                placeholder="pos-chat"
                value={draft.chatModel}
                onChange={(event) => setDraft({ ...draft, chatModel: event.target.value })}
              />
            </Field>
            <Field
              label="نام مستعار مدل بردارسازی (Embeddings)"
              hint="یکی از نام‌های model_list دروازه (مثلاً pos-embed)؛ می‌تواند از ارائه‌دهندهٔ دیگری بیاید."
            >
              <input
                className={inputClass}
                dir="ltr"
                placeholder="pos-embed"
                value={draft.embeddingModel}
                onChange={(event) => setDraft({ ...draft, embeddingModel: event.target.value })}
              />
            </Field>
            <div className="lg:col-span-2">
              <Field
                label="زنجیرهٔ جایگزین (Fallbacks)"
                hint="هر سطر یا کاما یک نام مستعار از model_list (مثلاً pos-cheap). این فهرست با هر درخواست به‌صورت fallbacks فرستاده می‌شود و باید با router_settings.fallbacks دروازه هم‌خوان باشد."
              >
                <textarea
                  className={inputClass}
                  dir="ltr"
                  rows={3}
                  value={fallbackText}
                  onChange={(event) => setFallbackText(event.target.value)}
                />
              </Field>
            </div>
            <Field
              label="روش توزیع (routing_strategy)"
              hint="تنظیم سمت دروازه است و با درخواست ارسال نمی‌شود؛ باید با router_settings.routing_strategy در config.yaml یکی باشد. «بررسی ارتباط» مقدار واقعی دروازه را می‌خواند و اختلاف را گزارش می‌کند."
            >
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
            <Field label="سقف پیش‌فرض توکن در دقیقه (TPM)">
              <PersianNumberInput
                className={inputClass}
                type="number"
                min="0"
                value={draft.defaultTpmLimit ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultTpmLimit: numericOrNull(event.target.value) })}
              />
            </Field>
            <Field label="سقف پیش‌فرض درخواست در دقیقه (RPM)">
              <PersianNumberInput
                className={inputClass}
                type="number"
                min="0"
                value={draft.defaultRpmLimit ?? ""}
                onChange={(event) => setDraft({ ...draft, defaultRpmLimit: numericOrNull(event.target.value) })}
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
                صدور کلید مجازی برای هر کسب‌وکار و شعبه
              </label>
              <label className="flex items-center gap-2 text-sm text-white/80">
                <input
                  type="checkbox"
                  checked={draft.allowBusinessModels}
                  onChange={(event) => setDraft({ ...draft, allowBusinessModels: event.target.checked })}
                />
                اجازهٔ انتخاب مدل به کسب‌وکار و شعبه‌ها
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
            <div className="lg:col-span-2 border-t border-white/10 pt-4">
              <Field
                label="سرورهای MCP دروازه"
                hint="هر سطر: name | برچسب | نشانی."
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

      {can("ai.credits.manage") ? (
        <Card title="کلید مجازی و سقف‌ها — کسب‌وکار و شعبه‌ها">
          <p className="mb-3 text-sm text-white/50">
            می‌توانید برای کل کسب‌وکار یا به‌صورت مجزا برای هر یک از شعبه‌های آن کلید مجازی و مدل تعیین کنید.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 mb-4">
            <Field label="کسب‌وکار">
              <SearchableSelect
                value={selectedBusinessId}
                onChange={(value) => {
                  setSelectedBusinessId(value);
                  setSelectedLocationId("");
                }}
                options={(data?.businesses ?? []).map((business) => ({ value: business.businessId, label: business.businessName }))}
              />
            </Field>
            {businessLocations.length > 0 ? (
              <Field label="شعبه (اختیاری)">
                <SearchableSelect
                  value={selectedLocationId}
                  onChange={setSelectedLocationId}
                  options={[
                    { value: "", label: "کل کسب‌وکار (پیش‌فرض)" },
                    ...businessLocations.map((loc) => ({ value: loc.id, label: loc.name })),
                  ]}
                />
              </Field>
            ) : null}
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
                  onClick={() =>
                    void write(
                      {
                        action: "sync_key",
                        businessId: selectedBusinessId,
                        locationId: selectedLocationId || null,
                      },
                      "sync",
                    )
                  }
                  disabled={Boolean(busy)}
                >
                  {busy === "sync" ? <Loader2Icon className="animate-spin" /> : "صدور / به‌روزرسانی کلید"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void write(
                      {
                        action: "refresh_spend",
                        businessId: selectedBusinessId,
                        locationId: selectedLocationId || null,
                      },
                      "spend",
                    )
                  }
                  disabled={Boolean(busy) || !selectedRow?.hasVirtualKey}
                >
                  {busy === "spend" ? <Loader2Icon className="animate-spin" /> : "به‌روزرسانی مصرف"}
                </Button>
                <Button
                  variant="danger"
                  onClick={() =>
                    void write(
                      {
                        action: "revoke_key",
                        businessId: selectedBusinessId,
                        locationId: selectedLocationId || null,
                      },
                      "revoke",
                    )
                  }
                  disabled={Boolean(busy) || !selectedRow?.hasVirtualKey}
                >
                  {busy === "revoke" ? <Loader2Icon className="animate-spin" /> : "لغو کلید"}
                </Button>
              </div>

              {draft?.allowBusinessModels && draft.publishedModels.length > 0 ? (
                <div className="grid gap-3 border-t border-white/10 pt-4 sm:grid-cols-2">
                  <Field label={`مدل اختصاصی ${selectedName}${selectedLocationId ? " (این شعبه)" : ""}`}>
                    <SearchableSelect
                      value={selectedRow?.modelOverride ?? ""}
                      onChange={(value) =>
                        void write(
                          {
                            action: "business",
                            businessId: selectedBusinessId,
                            locationId: selectedLocationId || null,
                            modelOverride: value || null,
                          },
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
            </div>
          ) : (
            <p className="text-sm text-white/40">یک کسب‌وکار را انتخاب کنید.</p>
          )}
        </Card>
      ) : null}

      <Card title="همهٔ کلیدهای مجازی">
        {!data?.gateways.length ? (
          <p className="text-sm text-white/40">هنوز کلیدی صادر نشده است.</p>
        ) : (
          <ul className="space-y-2">
            {data.gateways.map((row, idx) => (
              <li
                key={`${row.businessId}-${row.locationId || "biz"}-${idx}`}
                className="flex flex-col gap-1 rounded-lg border border-white/10 bg-white/2 p-3 text-sm md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <p className="font-medium" dir="ltr">
                    {row.keyAlias ?? row.businessId}
                    {row.locationId ? ` (شعبه: ${row.locationId.slice(0, 8)})` : " (کل کسب‌وکار)"}
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
