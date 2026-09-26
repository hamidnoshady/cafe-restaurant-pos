"use client";

/**
 * پلن‌ها و بسته‌ها — the ONE Plan Builder (migration 0176). Everything a
 * plan is lives on one row: identity, base pricing, operational limits (an
 * explicit محدود/نامحدود choice — never an accident), the monthly AI
 * allowance, the trial/grace defaults and the lifecycle status
 * (draft → active → retired). Retired plans stay readable forever and are
 * never hard-deleted; only an unused draft can be removed.
 *
 * The capability editor prices each feature of the plan (included / monthly
 * add-on / per-use / one-off add-on, with optional free-for-time and
 * free-for-N-uses promotions) using the real feature catalogue
 * (feature_flags) — no second capability registry.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  CheckCircle2Icon,
  Loader2Icon,
  PlusIcon,
  Settings2Icon,
  SparklesIcon,
  Trash2Icon,
} from "lucide-react";
import { formatJalali, toGregorian } from "@/lib/jalali";
import { toLatinDigits } from "@/lib/digits";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import {
  PlatformConfirmDialog,
  PlatformDangerDialog,
} from "@/components/platform/dialogs";
import { tomanLabel } from "@/lib/platform-money";
import {
  api,
  Button,
  Card,
  ErrorBox,
  Field,
  InfoBox,
  inputClass,
  SkeletonRows,
  useCan,
} from "../../ui";

export interface PlanFeature {
  id: string;
  planKey: string;
  featureKey: string;
  featureName: string | null;
  pricingModel: "included" | "monthly" | "per_use" | "addon";
  priceRial: number;
  freeUntil: string | null;
  freeLimit: number | null;
  sortOrder: number;
}

export interface Plan {
  key: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "retired";
  isActive: boolean;
  monthlyPriceRial: number | null;
  monthlyAiCreditRial: number | null;
  branchLimit: number | null;
  memberLimit: number | null;
  monthlyOrderLimit: number | null;
  trialDays: number;
  graceDays: number;
  sortOrder: number;
}

interface CatalogueEntry {
  key: string;
  name: string;
  description: string | null;
}

const STATUS_LABELS: Record<Plan["status"], string> = {
  draft: "پیش‌نویس",
  active: "فعال",
  retired: "بازنشسته",
};

const STATUS_CLASSES: Record<Plan["status"], string> = {
  draft: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  active: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  retired: "border-border bg-muted text-muted-foreground",
};

const MODEL_LABELS: Record<PlanFeature["pricingModel"], string> = {
  included: "رایگان در پلن",
  monthly: "افزودهٔ ماهانه (هزینه ثابت)",
  per_use: "متریک (به ازای هر استفاده)",
  addon: "خرید یک‌باره (افزونه)",
};

interface LimitDraft {
  unlimited: boolean;
  value: string;
}

/** ISO timestamp for the free-until input: a Jalali date is entered. */
function jalaliInputToIso(value: string): string | null {
  if (!value) return null;
  const m = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y > 1500) return new Date(`${value.slice(0, 10)}T23:59:59+03:30`).toISOString();
  const g = toGregorian(y, mo, d);
  return new Date(
    `${g.gy}-${String(g.gm).padStart(2, "0")}-${String(g.gd).padStart(2, "0")}T23:59:59+03:30`,
  ).toISOString();
}

export function BillingPlansTab() {
  const can = useCan();
  // The plan builder's writes are `plans.manage`-guarded (held today by every
  // role with `billing.manage`, so this changes no one's access).
  const canManage = can("plans.manage") || can("billing.manage");
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [featuresByPlan, setFeaturesByPlan] = useState<Record<string, PlanFeature[]>>({});
  const [catalogue, setCatalogue] = useState<CatalogueEntry[]>([]);
  const [selectedPlan, setSelectedPlan] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<
    | { kind: "retire"; plan: Plan }
    | { kind: "delete"; plan: Plan }
    | null
  >(null);

  const load = useCallback(async () => {
    const { ok, data } = await api<{
      plans: Plan[];
      featuresByPlan: Record<string, PlanFeature[]>;
      catalogue: CatalogueEntry[];
      error?: string;
    }>("/api/platform/billing/plans");
    if (ok) {
      setPlans(data.plans);
      setFeaturesByPlan(data.featuresByPlan ?? {});
      setCatalogue(data.catalogue ?? []);
      setSelectedPlan((current) => current || data.plans[0]?.key || "");
    } else {
      setError(data.error ?? "بارگذاری انجام نشد.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(() => plans?.find((p) => p.key === selectedPlan) ?? null, [plans, selectedPlan]);
  const currentFeatures = featuresByPlan[selectedPlan] ?? [];
  const usedKeys = new Set(currentFeatures.map((f) => f.featureKey));
  const availableCatalogue = catalogue.filter((c) => !usedKeys.has(c.key));

  return (
    <div className="space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info && <InfoBox>{info}</InfoBox>}
      {canManage && (
        <CreatePlanCard
          plans={plans ?? []}
          busy={busy === "create"}
          onBusy={setBusy}
          onDone={async (key) => {
            setInfo("پلن با موفقیت ساخته شد.");
            setSelectedPlan(key);
            await load();
          }}
          onError={setError}
        />
      )}

      <Card title="فهرست پلن‌ها">
        {!plans ? (
          <SkeletonRows rows={4} />
        ) : (
          <div className="space-y-2">
            {plans.map((plan) => (
              <button
                key={plan.key}
                type="button"
                onClick={() => setSelectedPlan(plan.key)}
                className={`flex w-full flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 text-right transition ${
                  selectedPlan === plan.key
                    ? "border-sky-400/60 bg-sky-500/10"
                    : "border-border bg-card hover:bg-muted"
                }`}
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="font-semibold text-foreground">{plan.name}</span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs ${STATUS_CLASSES[plan.status]}`}>
                    {STATUS_LABELS[plan.status]}
                  </span>
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {plan.key}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">
                    {plan.monthlyPriceRial ? `${tomanLabel(plan.monthlyPriceRial)}/ماه` : "بدون هزینهٔ پایه"}
                  </span>
                  <span className="tabular-nums">
                    شعبه: {limitText(plan.branchLimit)} · عضو: {limitText(plan.memberLimit)} · سفارش: {limitText(plan.monthlyOrderLimit)}
                  </span>
                  {plan.monthlyAiCreditRial ? (
                    <span className="tabular-nums text-violet-700 dark:text-violet-300">
                      ✦ {tomanLabel(plan.monthlyAiCreditRial)} اعتبار AI
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {selected && (
        <>
          <PlanIdentityCard
            plan={selected}
            canManage={canManage}
            busy={busy === "identity"}
            onBusy={setBusy}
            onDone={async (message) => {
              setInfo(message);
              await load();
            }}
            onError={setError}
          />

          {canManage && (
            <PlanLifecycleCard
              plan={selected}
              busy={busy}
              onBusy={setBusy}
              onConfirm={setConfirmAction}
              onDone={async (message) => {
                setInfo(message);
                await load();
              }}
              onError={setError}
            />
          )}

          <CapabilityEditorCard
            plan={selected}
            features={currentFeatures}
            catalogue={availableCatalogue}
            canManage={canManage && selected.status !== "retired"}
            busy={busy}
            onBusy={setBusy}
            onDone={async (message) => {
              setInfo(message);
              await load();
            }}
            onError={setError}
          />
        </>
      )}

      <PlatformConfirmDialog
        open={confirmAction?.kind === "retire"}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={`بازنشستگی پلن «${confirmAction?.plan.name ?? ""}»`}
        description="پلن برای مشتریان جدید بسته می‌شود؛ کسب‌وکارهای روی این پلن و اشتراک‌های تاریخی آن معتبر می‌مانند. این عمل قابل بازگشت نیست (بازنشسته دیگر فعال نمی‌شود)."
        confirmLabel="بازنشسته کن"
        busy={busy === "lifecycle"}
        onConfirm={async () => {
          if (!confirmAction) return;
          const { ok, data } = await api<{ error?: string }>("/api/platform/billing/plans", {
            method: "POST",
            body: JSON.stringify({ action: "retire", key: confirmAction.plan.key }),
          });
          setBusy(null);
          setConfirmAction(null);
          if (ok) {
            setInfo(`پلن «${confirmAction.plan.name}» بازنشسته شد.`);
            await load();
          } else {
            setError(data.error ?? "عملیات انجام نشد.");
          }
        }}
      />
      <PlatformDangerDialog
        open={confirmAction?.kind === "delete"}
        onOpenChange={(open) => !open && setConfirmAction(null)}
        title={`حذف پیش‌نویس «${confirmAction?.plan.name ?? ""}»`}
        description="فقط پیش‌نویسِ بلااستفاده قابل حذف قطعی است. اگر کسب‌وکار، اشتراک یا پرداختی به این پلن اشاره کند، حذف انجام نمی‌شود."
        confirmLabel="حذف قطعی"
        busy={busy === "lifecycle"}
        onConfirm={async () => {
          if (!confirmAction) return;
          setBusy("lifecycle");
          const { ok, data } = await api<{ error?: string }>(`/api/platform/billing/plans/${encodeURIComponent(confirmAction.plan.key)}`, {
            method: "DELETE",
          });
          setBusy(null);
          setConfirmAction(null);
          if (ok) {
            setInfo("پیش‌نویس حذف شد.");
            setSelectedPlan("");
            await load();
          } else {
            setError(data.error === "plan_not_draft" ? "فقط پیش‌نویس قابل حذف است." : data.error === "plan_in_use" ? "این پلن در حال استفاده است و حذف نمی‌شود." : data.error ?? "عملیات انجام نشد.");
          }
        }}
      />
    </div>
  );
}

export function limitText(limit: number | null): string {
  return limit == null ? "نامحدود" : String(limit);
}

// ---------------------------------------------------------------------------
// Create — identity + pricing + explicit limits in one small form
// ---------------------------------------------------------------------------

function CreatePlanCard({
  plans,
  busy,
  onBusy,
  onDone,
  onError,
}: {
  plans: Plan[];
  busy: boolean;
  onBusy: (key: string | null) => void;
  onDone: (key: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [aiCredit, setAiCredit] = useState("");
  const [status, setStatus] = useState<Plan["status"]>("active");
  const [branches, setBranches] = useState<LimitDraft>({ unlimited: false, value: "1" });
  const [members, setMembers] = useState<LimitDraft>({ unlimited: false, value: "5" });
  const [orders, setOrders] = useState<LimitDraft>({ unlimited: false, value: "500" });

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const toRial = (v: string) => {
      const parsed = Number(toLatinDigits(v || "0"));
      return parsed > 0 ? parsed * 10 : null;
    };
    const limitPayload = (draft: LimitDraft) =>
      draft.unlimited
        ? { unlimited: true, value: null }
        : { unlimited: false, value: Number(toLatinDigits(draft.value || "0")) };
    if (!name.trim()) {
      onError("نام پلن الزامی است.");
      return;
    }
    if (!branches.unlimited && !(Number(toLatinDigits(branches.value)) >= 0)) {
      onError("سقف شعبه را مشخص کنید یا «نامحدود» را انتخاب کنید.");
      return;
    }
    onBusy("create");
    const { ok, data } = await api<{ plan?: Plan; error?: string }>("/api/platform/billing/plans", {
      method: "POST",
      body: JSON.stringify({
        name: name.trim(),
        monthlyPriceRial: toRial(price),
        monthlyAiCreditRial: toRial(aiCredit),
        status,
        sortOrder: (plans.length + 1) * 10,
        limits: {
          branches: limitPayload(branches),
          members: limitPayload(members),
          monthlyOrders: limitPayload(orders),
        },
      }),
    });
    onBusy(null);
    if (ok && data.plan) {
      setName("");
      setPrice("");
      setAiCredit("");
      await onDone(data.plan.key);
    } else {
      onError(
        data.error === "limits_required"
          ? "برای هر سقف باید «محدود» یا «نامحدود» را صریح انتخاب کنید."
          : data.error === "invalid_limit"
            ? "مقدار سقف باید عددی بزرگ‌تر یا مساوی صفر باشد."
            : data.error ?? "ساخت پلن انجام نشد.",
      );
    }
  }

  return (
    <Card title="ساخت پلن جدید">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="نام پلن">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="مثلاً پلن طلایی" />
          </Field>
          <Field label="هزینهٔ ماهانهٔ پایه (تومان)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0 = بدون هزینه" />
          </Field>
          <Field label="اعتبار ماهانهٔ هوش مصنوعی (تومان)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={aiCredit} onChange={(e) => setAiCredit(e.target.value)} placeholder="مثلاً ۱۰۰٬۰۰۰" />
          </Field>
        </div>
        <LimitEditor label="سقف شعبه‌ها" draft={branches} onChange={setBranches} />
        <LimitEditor label="سقف اعضا" draft={members} onChange={setMembers} />
        <LimitEditor label="سقف سفارش ماهانه" draft={orders} onChange={setOrders} />
        <div className="flex flex-wrap items-end gap-3">
          <Field label="وضعیت اولیه">
            <select className={inputClass} value={status} onChange={(e) => setStatus(e.target.value as Plan["status"])}>
              <option value="draft">پیش‌نویس (فعلاً قابل خرید نیست)</option>
              <option value="active">فعال (قابل خرید)</option>
            </select>
          </Field>
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
            ساخت پلن
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          هر سقف باید صریحاً «محدود» یا «نامحدود» انتخاب شود؛ پلن تازه هرگز اتفاقی نامحدود نمی‌شود.
          چهار برنامهٔ محصول (حسابداری، ارتباط با مشتری، رشد و بازاریابی، مدیریت وب‌سایت) در فهرست قابلیت‌های هر پلن بسته‌بندی می‌شوند.
        </p>
      </form>
    </Card>
  );
}

function LimitEditor({
  label,
  draft,
  onChange,
}: {
  label: string;
  draft: LimitDraft;
  onChange: (draft: LimitDraft) => void;
}) {
  return (
    <fieldset className="rounded-xl border border-border bg-card p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{label}</legend>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`limit-${label}`}
            checked={!draft.unlimited}
            onChange={() => onChange({ unlimited: false, value: draft.value })}
            className="size-4"
          />
          محدود
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`limit-${label}`}
            checked={draft.unlimited}
            onChange={() => onChange({ unlimited: true, value: draft.value })}
            className="size-4"
          />
          نامحدود
        </label>
        {!draft.unlimited && (
          <PersianNumberInput
            className={`${inputClass} w-32`}
            inputMode="numeric"
            value={draft.value}
            onChange={(e) => onChange({ unlimited: false, value: e.target.value })}
            aria-label={`${label} — مقدار`}
          />
        )}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Identity / pricing / limits editing
// ---------------------------------------------------------------------------

function PlanIdentityCard({
  plan,
  canManage,
  busy,
  onBusy,
  onDone,
  onError,
}: {
  plan: Plan;
  canManage: boolean;
  busy: boolean;
  onBusy: (key: string | null) => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? "");
  const [price, setPrice] = useState(plan.monthlyPriceRial ? String(Math.round(plan.monthlyPriceRial / 10)) : "");
  const [aiCredit, setAiCredit] = useState(plan.monthlyAiCreditRial ? String(Math.round(plan.monthlyAiCreditRial / 10)) : "");
  const [branches, setBranches] = useState<LimitDraft>(
    plan.branchLimit == null ? { unlimited: true, value: "" } : { unlimited: false, value: String(plan.branchLimit) },
  );
  const [members, setMembers] = useState<LimitDraft>(
    plan.memberLimit == null ? { unlimited: true, value: "" } : { unlimited: false, value: String(plan.memberLimit) },
  );
  const [orders, setOrders] = useState<LimitDraft>(
    plan.monthlyOrderLimit == null ? { unlimited: true, value: "" } : { unlimited: false, value: String(plan.monthlyOrderLimit) },
  );
  const [graceDays, setGraceDays] = useState(String(plan.graceDays));

  useEffect(() => {
    setName(plan.name);
    setDescription(plan.description ?? "");
    setPrice(plan.monthlyPriceRial ? String(Math.round(plan.monthlyPriceRial / 10)) : "");
    setAiCredit(plan.monthlyAiCreditRial ? String(Math.round(plan.monthlyAiCreditRial / 10)) : "");
    setBranches(plan.branchLimit == null ? { unlimited: true, value: "" } : { unlimited: false, value: String(plan.branchLimit) });
    setMembers(plan.memberLimit == null ? { unlimited: true, value: "" } : { unlimited: false, value: String(plan.memberLimit) });
    setOrders(plan.monthlyOrderLimit == null ? { unlimited: true, value: "" } : { unlimited: false, value: String(plan.monthlyOrderLimit) });
    setGraceDays(String(plan.graceDays));
  }, [plan]);

  async function save(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    const toRial = (v: string) => {
      const parsed = Number(toLatinDigits(v || "0"));
      return parsed > 0 ? parsed * 10 : null;
    };
    const limitPayload = (draft: LimitDraft) =>
      draft.unlimited ? { unlimited: true, value: null } : { unlimited: false, value: Number(toLatinDigits(draft.value || "0")) };
    onBusy("identity");
    const { ok, data } = await api<{ plan?: Plan; error?: string }>("/api/platform/billing/plans", {
      method: "POST",
      body: JSON.stringify({
        key: plan.key,
        name,
        description,
        monthlyPriceRial: toRial(price),
        monthlyAiCreditRial: toRial(aiCredit),
        status: plan.status,
        sortOrder: plan.sortOrder,
        graceDays: Number(toLatinDigits(graceDays || "7")),
        limits: {
          branches: limitPayload(branches),
          members: limitPayload(members),
          monthlyOrders: limitPayload(orders),
        },
      }),
    });
    onBusy(null);
    if (ok) await onDone("مشخصات پلن ذخیره شد.");
    else onError(data.error === "invalid_limit" ? "مقدار سقف باید عددی بزرگ‌تر یا مساوی صفر باشد." : data.error ?? "ذخیره انجام نشد.");
  }

  return (
    <Card title={`ویرایش پلن «${plan.name}»`}>
      <form onSubmit={save} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="نام">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} />
          </Field>
          <Field label="هزینهٔ ماهانهٔ پایه (تومان)">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} disabled={!canManage} placeholder="0 = بدون هزینه" />
          </Field>
          <Field label="اعتبار ماهانهٔ هوش مصنوعی (تومان)" hint="مصرف هر ماه ابتدا از این اعتبار کسر می‌شود؛ مازاد آن از کیف پول.">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={aiCredit} onChange={(e) => setAiCredit(e.target.value)} disabled={!canManage} placeholder="0 = بدون اعتبار" />
          </Field>
          <Field label="مهلت بازپرداخت پس از ناتوانی (روز)" hint="مدت مهلتی که اشتراک پس از شکست تمدید، عقب‌افتاده می‌ماند.">
            <PersianNumberInput className={inputClass} inputMode="numeric" value={graceDays} onChange={(e) => setGraceDays(e.target.value)} disabled={!canManage} />
          </Field>
        </div>
        <Field label="توضیح">
          <input className={inputClass} value={description} onChange={(e) => setDescription(e.target.value)} disabled={!canManage} />
        </Field>
        <div className="grid gap-3 lg:grid-cols-3">
          <LimitEditor label="سقف شعبه‌ها" draft={branches} onChange={setBranches} />
          <LimitEditor label="سقف اعضا" draft={members} onChange={setMembers} />
          <LimitEditor label="سقف سفارش ماهانه" draft={orders} onChange={setOrders} />
        </div>
        {canManage && (
          <Button type="submit" disabled={busy}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : <Settings2Icon className="size-4" />}
            ذخیرهٔ مشخصات
          </Button>
        )}
        <p className="text-xs text-muted-foreground">
          تغییر سقف‌ها فقط برای کسب‌وکارهای این پلن از همین لحظه اعمال می‌شود؛ فاکتورهای تاریخی تغییر نمی‌کنند.
        </p>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

function PlanLifecycleCard({
  plan,
  busy,
  onBusy,
  onConfirm,
  onDone,
  onError,
}: {
  plan: Plan;
  busy: string | null;
  onBusy: (key: string | null) => void;
  onConfirm: (action: { kind: "retire" | "delete"; plan: Plan } | null) => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  async function transition(action: "activate") {
    onBusy("lifecycle");
    const { ok, data } = await api<{ plan?: Plan; error?: string }>("/api/platform/billing/plans", {
      method: "POST",
      body: JSON.stringify({ action, key: plan.key }),
    });
    onBusy(null);
    if (ok) await onDone(`پلن «${plan.name}» فعال شد.`);
    else onError(data.error === "plan_retired" ? "پلن بازنشسته قابل فعال‌سازی مجدد نیست." : data.error ?? "عملیات انجام نشد.");
  }

  return (
    <Card title="چرخهٔ عمر پلن">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={`rounded-full border px-2.5 py-0.5 text-xs ${STATUS_CLASSES[plan.status]}`}>
          {STATUS_LABELS[plan.status]}
        </span>
        <p className="text-muted-foreground">
          {plan.status === "draft" && "پیش‌نویس قابل ویرایش است اما برای خرید و انتساب در دسترس نیست."}
          {plan.status === "active" && "پلن فعال است: قابل خرید و انتساب به کسب‌وکارها."}
          {plan.status === "retired" && "پلن برای مشتریان جدید بسته است؛ اشتراک‌های موجود و تاریخی معتبر می‌مانند."}
        </p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {plan.status === "draft" && (
          <>
            <Button onClick={() => void transition("activate")} disabled={busy === "lifecycle"}>
              {busy === "lifecycle" ? <Loader2Icon className="size-4 animate-spin" /> : <CheckCircle2Icon className="size-4" />}
              فعال‌سازی
            </Button>
            <Button variant="danger" onClick={() => onConfirm({ kind: "delete", plan })} disabled={busy === "lifecycle"}>
              <Trash2Icon className="size-4" />
              حذف پیش‌نویس
            </Button>
          </>
        )}
        {plan.status === "active" && (
          <Button variant="danger" onClick={() => onConfirm({ kind: "retire", plan })} disabled={busy === "lifecycle"}>
            بازنشستگی پلن
          </Button>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Capability pricing editor
// ---------------------------------------------------------------------------

function CapabilityEditorCard({
  plan,
  features,
  catalogue,
  canManage,
  busy,
  onBusy,
  onDone,
  onError,
}: {
  plan: Plan;
  features: PlanFeature[];
  catalogue: CatalogueEntry[];
  canManage: boolean;
  busy: string | null;
  onBusy: (key: string | null) => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [featureKey, setFeatureKey] = useState("");
  const [pricingModel, setPricingModel] = useState<PlanFeature["pricingModel"]>("included");
  const [price, setPrice] = useState("");
  const [freeUntil, setFreeUntil] = useState("");
  const [freeLimit, setFreeLimit] = useState("");

  async function saveFeature(ev: FormEvent) {
    ev.preventDefault();
    onError("");
    if (!featureKey) {
      onError("قابلیت را انتخاب کنید.");
      return;
    }
    onBusy("feature");
    const priceToman = Math.max(0, Number(toLatinDigits(price || "0")));
    const { ok, data } = await api<{ error?: string }>(
      `/api/platform/billing/plans/${encodeURIComponent(plan.key)}/features`,
      {
        method: "POST",
        body: JSON.stringify({
          featureKey,
          pricingModel,
          priceRial: priceToman * 10,
          freeUntil: pricingModel === "per_use" ? jalaliInputToIso(freeUntil) : null,
          freeLimit:
            pricingModel === "per_use" && freeLimit
              ? Math.max(0, Number(toLatinDigits(freeLimit)))
              : null,
          sortOrder: features.length + 1,
        }),
      },
    );
    onBusy(null);
    if (ok) {
      setFeatureKey("");
      setPrice("");
      setFreeUntil("");
      setFreeLimit("");
      await onDone("قیمت‌گذاری قابلیت ذخیره شد.");
    } else {
      onError(data.error === "plan_retired" ? "پلن بازنشسته قابل ویرایش نیست." : data.error ?? "ذخیره انجام نشد.");
    }
  }

  async function removeFeature(feature: PlanFeature) {
    onBusy(`del-${feature.id}`);
    await api(
      `/api/platform/billing/plans/${encodeURIComponent(plan.key)}/features?featureKey=${encodeURIComponent(feature.featureKey)}`,
      { method: "DELETE" },
    );
    onBusy(null);
    await onDone("قابلیت از پلن حذف شد.");
  }

  return (
    <Card title={`قابلیت‌های پلن «${plan.name}»`}>
      {canManage && (
        <form onSubmit={saveFeature} className="mb-4 rounded-xl border border-border bg-card p-4">
          <p className="mb-3 text-sm font-semibold text-foreground">افزودن / به‌روزرسانی قابلیت</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="قابلیت (از کاتالوگ واقعی محصول)">
              <select className={inputClass} value={featureKey} onChange={(e) => setFeatureKey(e.target.value)}>
                <option value="">انتخاب کنید…</option>
                {catalogue.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.name} ({c.key})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="مدل تجاری">
              <select
                className={inputClass}
                value={pricingModel}
                onChange={(e) => setPricingModel(e.target.value as PlanFeature["pricingModel"])}
              >
                <option value="included">{MODEL_LABELS.included}</option>
                <option value="monthly">{MODEL_LABELS.monthly}</option>
                <option value="per_use">{MODEL_LABELS.per_use}</option>
                <option value="addon">{MODEL_LABELS.addon}</option>
              </select>
            </Field>
            {pricingModel !== "included" && (
              <Field
                label={
                  pricingModel === "monthly"
                    ? "هزینهٔ ماهانه (تومان)"
                    : pricingModel === "addon"
                      ? "قیمت خرید (تومان)"
                      : "هزینهٔ هر استفاده (تومان)"
                }
              >
                <PersianNumberInput className={inputClass} inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0 = رایگان" />
              </Field>
            )}
            {pricingModel === "per_use" && (
              <>
                <Field label="رایگان تا تاریخ (هجری شمسی) — اختیاری">
                  <input className={inputClass} placeholder="مثلاً ۱۴۰۴/۱۲/۲۹" value={freeUntil} onChange={(e) => setFreeUntil(e.target.value)} />
                </Field>
                <Field label="تعداد استفادهٔ رایگان — اختیاری">
                  <PersianNumberInput className={inputClass} inputMode="numeric" value={freeLimit} onChange={(e) => setFreeLimit(e.target.value)} placeholder="مثلاً ۵۰" />
                </Field>
              </>
            )}
          </div>
          <div className="mt-3">
            <Button type="submit" disabled={busy === "feature"}>
              {busy === "feature" ? <Loader2Icon className="size-4 animate-spin" /> : <PlusIcon className="size-4" />}
              ذخیرهٔ قابلیت
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            «رایگان تا تاریخ» یعنی تا آن تاریخ هزینه‌ای ندارد؛ «تعداد استفادهٔ رایگان» یعنی تا آن تعداد، کسر اعتبار انجام نمی‌شود.
          </p>
        </form>
      )}

      {plan.status === "retired" && (
        <InfoBox>پلن بازنشسته است و سطرهای قیمت‌گذاری آن به‌عنوان سند تاریخی تغییر نمی‌کنند.</InfoBox>
      )}

      <div className="space-y-2">
        {features.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            برای این پلن هنوز قابلیتی قیمت‌گذاری نشده است.
          </p>
        )}
        {features.map((f) => (
          <div key={f.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{f.featureName ?? f.featureKey}</p>
              <p className="text-xs text-muted-foreground">
                {MODEL_LABELS[f.pricingModel]}
                {f.pricingModel !== "included" && f.priceRial > 0 && ` · ${tomanLabel(f.priceRial)}`}
                {f.freeUntil && ` · رایگان تا ${formatJalali(f.freeUntil, { withMonthName: true })}`}
                {f.freeLimit != null && ` · ${String(f.freeLimit)} استفادهٔ رایگان`}
              </p>
            </div>
            {canManage && (
              <button
                type="button"
                onClick={() => void removeFeature(f)}
                disabled={busy?.startsWith("del")}
                className="text-red-700 dark:text-red-300 hover:text-red-800 dark:hover:text-red-200"
                aria-label="حذف قابلیت از پلن"
              >
                <Trash2Icon className="size-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
