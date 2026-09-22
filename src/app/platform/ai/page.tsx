"use client";

/**
 * Superadmin AI Page — Technical LiteLLM Integration & Business Virtual Keys.
 *
 * Exclusively manages the LiteLLM connection parameters and per-business
 * virtual-key lifecycle. All pricing, plans, allowances, wallet balances
 * and billing belong strictly to Plan/Billing (/platform/plans and business billing).
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { formatPersianNumber } from "@/lib/digits";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  errorMessage,
  useCan,
  PlatformPageSkeleton,
} from "../ui";

interface GatewayConfig {
  enabled: boolean;
  baseUrl: string;
  chatModel: string;
  embeddingModel: string;
  virtualKeysEnabled: boolean;
  allowBusinessModels: boolean;
  publishedModels: string[];
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
  spendUsd: number;
  syncedAt: string | null;
  syncError: string | null;
  hasVirtualKey: boolean;
  effectiveModel: string;
}

interface GatewayProbeStage {
  id: "liveliness" | "auth" | "model" | "completion" | "virtual_keys";
  label: string;
  ok: boolean;
  error?: string | null;
  detail?: string | null;
}

interface GatewayStatus {
  ok: boolean;
  latencyMs: number | null;
  models: string[];
  stages?: GatewayProbeStage[];
  error: string | null;
  detail?: string | null;
}

interface RuntimeReadiness {
  ready: boolean;
  reason: string | null;
  gatewayReady: boolean;
  authenticationReady: boolean;
  virtualKeyRequired: boolean;
  virtualKeyReady: boolean;
  modelReady: boolean;
}

interface TenantReadiness extends RuntimeReadiness {
  businessId: string;
  entitled: boolean;
}

interface GatewayData {
  gateway: GatewayConfig | null;
  provider: string;
  platformModel: string;
  platformBaseUrl: string;
  providerIsGateway: boolean;
  active: boolean;
  runtimeReadiness: RuntimeReadiness;
  tenantReadiness: TenantReadiness[];
  status: GatewayStatus | null;
  gateways: BusinessGateway[];
  businesses: BusinessSummary[];
  locations: LocationSummary[];
  error?: string;
}

interface BusinessSummary {
  businessId: string;
  businessName: string;
  aiEntitled: boolean;
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

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const READINESS_REASON_FA: Record<string, string> = {
  platform_disabled: "هوش مصنوعی پلتفرم غیرفعال است",
  gateway_disabled: "دروازه LiteLLM غیرفعال است",
  missing_base_url: "نشانی Base URL تنظیم نشده است",
  invalid_base_url: "نشانی Base URL معتبر نیست",
  missing_runtime_credential: "اعتبارنامهٔ اجرای درخواست موجود نیست",
  tenant_virtual_key_missing: "کلید مجازی این کسب‌وکار صادر نشده است",
  missing_model: "مدل گفت‌وگو تنظیم نشده است",
  invalid_max_output_tokens: "سقف توکن خروجی معتبر نیست",
  configuration_load_failed: "خواندن تنظیمات پایگاه داده ناموفق بود",
};

function readinessText(readiness: RuntimeReadiness | undefined): string {
  if (!readiness) return "نامشخص";
  return readiness.ready ? "آماده" : (readiness.reason ? READINESS_REASON_FA[readiness.reason] ?? readiness.reason : "نیازمند تنظیم");
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
  const [publishedText, setPublishedText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api<GatewayData>("/api/platform/ai/gateway");
    if (!result.ok) {
      setError(result.data.error === "ai_configuration_load_failed"
        ? "خواندن تنظیمات هوش مصنوعی ناموفق بود؛ لاگ سرور را بررسی کنید."
        : result.data.error ? errorMessage(result.data.error) : "خواندن تنظیمات دروازه ممکن نشد.");
      setLoading(false);
      return;
    }
    setData(result.data);
    setDraft(result.data.gateway);
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

  const selectedReadiness = useMemo(
    () => data?.tenantReadiness?.find((item) => item.businessId === selectedBusinessId),
    [data?.tenantReadiness, selectedBusinessId],
  );

  const keyRows = useMemo(() => {
    const businesses = data?.businesses ?? [];
    const gateways = data?.gateways ?? [];
    return businesses.map((business) => {
      const key = gateways.find((row) => row.businessId === business.businessId && row.locationId === null);
      const readiness = data?.tenantReadiness?.find((item) => item.businessId === business.businessId);
      return { business, key: key ?? null, readiness };
    });
  }, [data?.businesses, data?.gateways, data?.tenantReadiness]);

  async function write(body: Record<string, unknown>, key: string, method: "PUT" | "POST" = "POST") {
    setBusy(key);
    setError("");
    setNotice("");
    const result = await api<{
      error?: string;
      detail?: string | null;
      gateway?: { syncError?: string | null };
    }>("/api/platform/ai/gateway", {
      method,
      body: JSON.stringify(body),
    });
    setBusy("");
    if (!result.ok) {
      const message = result.data.error ? errorMessage(result.data.error) : "انجام عملیات ممکن نشد.";
      setError(result.data.detail ? `${message} — ${result.data.detail}` : message);
      return false;
    }
    if (result.data.gateway?.syncError) {
      setError(result.data.gateway.syncError);
      await load();
      return false;
    }
    setNotice("تغییرات با موفقیت ذخیره شد.");
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
          publishedModels: parseList(publishedText),
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
          publishedModels: parseList(publishedText),
          masterKey: masterKey || undefined,
        },
      }),
    });
    setBusy("");
    if (!result.ok) {
      setError(result.data.error ? errorMessage(result.data.error) : "بررسی ارتباط ممکن نشد.");
      return;
    }
    setData((current) => (current ? { ...current, status: result.data.status } : current));
  }

  useEffect(() => {
    if (draft) {
      setPublishedText(listText(draft.publishedModels));
    }
  }, [draft]);

  if (loading) return <PlatformPageSkeleton />;

  const status = data?.status;

  return (
    <div className="mx-auto w-full max-w-6xl space-y-4 sm:space-y-6">
      <header>
        <h1 className="text-xl font-bold">تنظیمات هوش مصنوعی (LiteLLM)</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          اتصال به دروازهٔ یکپارچهٔ LiteLLM و مدیریت کلیدهای مجازی کسب‌وکارها. تنظیمات قیمت، پلن‌ها، بسته‌ها و کیف پول به‌صورت متمرکز در بخش صورت‌حساب و پلن‌ساز مدیریت می‌شوند.
        </p>
      </header>

      <ErrorBox>{error}</ErrorBox>
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      {/* Connection Status & Multi-Stage Diagnostic Probe */}
      <Card title="وضعیت اتصال دروازه">
        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">ارائه‌دهنده</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              LiteLLM
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">وضعیت فنی پلتفرم</dt>
            <dd className="mt-1 font-medium">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                  data?.runtimeReadiness?.ready
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                }`}
              >
                {readinessText(data?.runtimeReadiness)}
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">مدل پیش‌فرض گفت‌وگو</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.platformModel ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-muted-foreground">نشانی دروازه (Base URL)</dt>
            <dd className="mt-1 font-medium" dir="ltr">
              {data?.platformBaseUrl ?? "—"}
            </dd>
          </div>
        </dl>

        {status ? (
          <div className="mt-4 rounded-xl border border-border bg-card p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h4 className="text-sm font-semibold">
                {status.ok ? (
                  <span className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2Icon className="size-4" />
                    ارتباط با دروازهٔ LiteLLM کاملاً برقرار و عملیاتی است
                  </span>
                ) : (
                  <span className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
                    <XCircleIcon className="size-4" />
                    اشکال در ارتباط یا تست مدل
                  </span>
                )}
              </h4>
              {status.latencyMs !== null && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  زمان پاسخ: {formatPersianNumber(status.latencyMs)} میلی‌ثانیه
                </span>
              )}
            </div>

            {status.error ? (
              <p className="text-xs text-rose-700 dark:text-rose-300">
                {status.error}
              </p>
            ) : null}

            {status.stages && status.stages.length > 0 ? (
              <div className="space-y-1.5 pt-1">
                {status.stages.map((stage) => (
                  <div key={stage.id} className="flex items-start justify-between text-xs py-1 px-2 rounded bg-muted/40">
                    <div className="flex items-center gap-2">
                      {stage.ok ? (
                        <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                      ) : (
                        <XCircleIcon className="size-3.5 text-rose-600 dark:text-rose-400 shrink-0" />
                      )}
                      <span className={stage.ok ? "text-foreground font-medium" : "text-rose-700 dark:text-rose-300 font-medium"}>
                        {stage.label}
                      </span>
                    </div>
                    {stage.detail ? (
                      <span className="text-muted-foreground text-[11px] font-mono" dir="ltr">
                        {stage.detail}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            ) : null}

            {status.models && status.models.length > 0 ? (
              <div className="pt-2 border-t border-border">
                <p className="text-xs text-muted-foreground mb-1">مدل‌های قابل استفاده در دروازه:</p>
                <div className="flex flex-wrap gap-1">
                  {status.models.map((m) => (
                    <span key={m} className="inline-block px-2 py-0.5 rounded bg-muted text-[11px] font-mono text-foreground" dir="ltr">
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {can("ai.config.manage") ? (
          <div className="mt-4">
            <Button type="button" variant="ghost" onClick={() => void probe()} disabled={Boolean(busy)}>
              {busy === "probe" ? <Loader2Icon className="animate-spin" /> : "بررسی و آزمایش کامل اتصال"}
            </Button>
          </div>
        ) : null}
      </Card>

      {/* SECTION A: LiteLLM Technical Connection */}
      {can("ai.config.manage") && draft ? (
        <Card title="تنظیمات اتصال LiteLLM">
          <p className="mb-4 text-sm text-muted-foreground">
            پیکربندی اتصال سرور به LiteLLM Proxy. کلید مدیر (Master Key) به‌صورت محرمانه نگهداری می‌شود و تنها برای عملیات مدیریتی و صدور کلیدهای مجازی استفاده می‌گردد.
          </p>
          <form onSubmit={saveConfig} className="grid gap-4 lg:grid-cols-2">
            <Field label="نشانی دروازه (Base URL)">
              <input
                className={inputClass}
                dir="ltr"
                placeholder="http://litellm:4000/v1"
                value={draft.baseUrl}
                onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
              />
            </Field>

            <Field
              label="کلید مدیر (Master Key)"
              hint={draft.hasMasterKey ? "کلید مدیر ذخیره شده است؛ برای حفظ آن خالی بگذارید." : "کلید مدیر دروازه را وارد کنید."}
            >
              <input
                className={inputClass}
                dir="ltr"
                type="password"
                value={masterKey}
                onChange={(event) => setMasterKey(event.target.value)}
                autoComplete="off"
                placeholder="sk-..."
              />
            </Field>

            <Field
              label="نام مستعار مدل گفت‌وگو (Chat Model Alias)"
              hint="یکی از نام‌های model_list در LiteLLM (مثلاً pos-chat). درخواست‌های دستیار با این نام فرستاده می‌شوند."
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
              label="نام مستعار مدل بردارسازی (Embedding Model Alias)"
              hint="نام مستعار مدل بردارسازی در LiteLLM (مثلاً pos-embed) برای جست‌وجوی معنایی دانش."
            >
              <input
                className={inputClass}
                dir="ltr"
                placeholder="pos-embed"
                value={draft.embeddingModel}
                onChange={(event) => setDraft({ ...draft, embeddingModel: event.target.value })}
              />
            </Field>

            <div className="lg:col-span-2 space-y-2 border-t border-border pt-4">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                />
                فعال بودن دستیار هوش مصنوعی پلتفرم
              </label>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.virtualKeysEnabled}
                  onChange={(event) => setDraft({ ...draft, virtualKeysEnabled: event.target.checked })}
                />
                صدور و تفکیک کلید مجازی (Virtual Key) برای هر کسب‌وکار و شعبه
              </label>

              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={draft.allowBusinessModels}
                  onChange={(event) => setDraft({ ...draft, allowBusinessModels: event.target.checked })}
                />
                اجازهٔ انتخاب مدل به کسب‌وکارها از میان مدل‌های مجاز
              </label>
            </div>

            {draft.allowBusinessModels ? (
              <div className="lg:col-span-2">
                <Field label="مدل‌های مجاز و قابل انتخاب" hint="یک سطر برای هر نام مستعار مدل. فقط این مدل‌ها به کسب‌وکارها پیشنهاد می‌شوند.">
                  <textarea
                    className={inputClass}
                    dir="ltr"
                    rows={3}
                    placeholder="pos-chat&#10;pos-fast"
                    value={publishedText}
                    onChange={(event) => setPublishedText(event.target.value)}
                  />
                </Field>
              </div>
            ) : null}

            <div className="lg:col-span-2 pt-2">
              <Button type="submit" disabled={busy === "config"}>
                {busy === "config" ? <Loader2Icon className="animate-spin" /> : "ذخیره تنظیمات دروازه"}
              </Button>
            </div>
          </form>
        </Card>
      ) : null}

      {/* SECTION B: Business Virtual Keys Management */}
      <Card title="مدیریت کلیدهای مجازی کسب‌وکارها">
        <p className="mb-3 text-sm text-muted-foreground">
          صدور، نظارت و لغو کلیدهای مجازی LiteLLM برای کسب‌وکارها و شعبه‌ها. هر کلید مجازی هویت مستقل دارد و درخواست‌های کسب‌وکار با کلید اختصاصی ارسال می‌شود.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 mb-4">
          <Field label="انتخاب کسب‌وکار">
            <SearchableSelect
              value={selectedBusinessId}
              onChange={(value) => {
                setSelectedBusinessId(value);
                setSelectedLocationId("");
              }}
              options={(data?.businesses ?? []).map((business) => ({
                value: business.businessId,
                label: business.businessName,
              }))}
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
          <div className="space-y-4 border-t border-border pt-4">
            <div
              className={`rounded-lg border p-3 text-sm ${
                selectedReadiness?.ready && selectedReadiness.entitled
                  ? "border-emerald-300 bg-emerald-50 dark:bg-emerald-500/10"
                  : "border-amber-300 bg-amber-50 dark:bg-amber-500/10"
              }`}
            >
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <p>
                  دسترسی هوش مصنوعی:{" "}
                  <strong>{selectedReadiness?.entitled ? "فعال است" : "غیرفعال است"}</strong>
                </p>
                <p>
                  اتصال دروازه:{" "}
                  <strong>{selectedReadiness?.gatewayReady ? "آماده" : "غیرآماده"}</strong>
                </p>
                <p>
                  کلید مجازی:{" "}
                  <strong>
                    {selectedRow?.hasVirtualKey ? "صادر شده" : "صادر نشده"}
                  </strong>
                </p>
                <p>
                  مدل مؤثر:{" "}
                  <strong dir="ltr" className="font-medium">
                    {selectedRow?.effectiveModel ?? data?.platformModel ?? "—"}
                  </strong>
                </p>
                <p>
                  نام مستعار کلید:{" "}
                  <span dir="ltr" className="font-mono text-xs">
                    {selectedRow?.keyAlias ?? "—"}
                  </span>
                </p>
                <p>
                  آخرین همگام‌سازی:{" "}
                  <span>{fmtDate(selectedRow?.syncedAt ?? null)}</span>
                </p>
              </div>
              {selectedReadiness && (!selectedReadiness.ready || !selectedReadiness.entitled) ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  علت: {!selectedReadiness.entitled ? "دسترسی ai_assistant فعال نشده است" : readinessText(selectedReadiness)}
                </p>
              ) : null}
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
                {busy === "spend" ? <Loader2Icon className="animate-spin" /> : "آزمایش و استعلام کلید"}
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
              <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
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
          <p className="text-sm text-muted-foreground">یک کسب‌وکار را برای مشاهده یا مدیریت کلید انتخاب کنید.</p>
        )}
      </Card>

      {/* SECTION C: Business Virtual Keys Directory */}
      <Card title="فهرست کلیدهای مجازی کسب‌وکارها">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-right text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th className="py-2 pr-1">کسب‌وکار</th>
                <th className="py-2">کلید مجازی</th>
                <th className="py-2">مدل مؤثر</th>
                <th className="py-2">وضعیت آمادگی</th>
                <th className="py-2">آخرین همگام‌سازی</th>
                <th className="py-2">عملیات</th>
              </tr>
            </thead>
            <tbody>
              {keyRows.map(({ business, key, readiness }) => (
                <tr key={business.businessId} className="border-b border-border">
                  <td className="py-2 pr-1">
                    <p className="font-medium text-foreground">{business.businessName}</p>
                    <p className="text-xs text-muted-foreground">
                      {business.aiEntitled ? "هوش مصنوعی فعال" : "هوش مصنوعی غیرفعال"}
                    </p>
                  </td>
                  <td className="py-2">
                    <span dir="ltr" className="font-mono text-xs block">
                      {key?.keyAlias ?? "—"}
                    </span>
                    <span
                      className={`inline-block text-[11px] px-1.5 py-0.2 rounded font-medium ${
                        key?.hasVirtualKey
                          ? key.syncError
                            ? "bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-300"
                            : "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {key?.hasVirtualKey ? (key.syncError ? "خطای همگام‌سازی" : "صادر شده") : "صادر نشده"}
                    </span>
                  </td>
                  <td className="py-2">
                    <span dir="ltr" className="text-xs font-mono">
                      {key?.effectiveModel ?? data?.platformModel ?? "—"}
                    </span>
                  </td>
                  <td className="py-2">
                    <span
                      className={`text-xs ${
                        readiness?.ready && readiness?.entitled
                          ? "text-emerald-700 dark:text-emerald-300 font-medium"
                          : "text-amber-700 dark:text-amber-300"
                      }`}
                    >
                      {readinessText(readiness)}
                    </span>
                  </td>
                  <td className="py-2 text-xs text-muted-foreground tabular-nums">
                    {fmtDate(key?.syncedAt ?? null)}
                  </td>
                  <td className="py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedBusinessId(business.businessId);
                        setSelectedLocationId("");
                      }}
                      className="text-xs text-sky-600 hover:text-sky-700 dark:text-sky-400 font-medium"
                    >
                      مدیریت کلید
                    </button>
                  </td>
                </tr>
              ))}
              {keyRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-muted-foreground">
                    هنوز کسب‌وکاری ثبت نشده است.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
