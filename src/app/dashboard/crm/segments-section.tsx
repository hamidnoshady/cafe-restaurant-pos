"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

/**
 * Segment builder and list (Phase 36).
 *
 * The builder writes a **rule document**, never SQL. Every field comes from the
 * closed `SEGMENT_FIELDS` union and every value is bound as a parameter by
 * `compileSegment`, so a segment is user-authored logic that cannot become a
 * user-authored query. That property is enforced in `src/lib/segments.ts` and
 * tested there; this screen's job is to make the document easy to write.
 *
 * The preview is the other half. It shows two numbers — how many customers
 * match, and how many of those can actually be contacted for the chosen
 * purpose — because the gap between them is the fact that decides whether a
 * campaign is worth running. A builder that showed only the consented count
 * would look like it was losing people for no reason.
 */

import { useCallback, useEffect, useState } from "react";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useMoney } from "@/components/money/money-context";
import { formatPersianNumber, toLatinDigits, toPersianDigits } from "@/lib/digits";
import {
  describeSegment,
  SEGMENT_FIELDS,
  SEGMENT_OPERATOR_LABELS,
  segmentFieldMeta,
  type SegmentDefinition,
  type SegmentField,
  type SegmentPurpose,
  type SegmentRule,
} from "@/lib/segments";
import { EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { api, ErrorBox, errorMessage, Field, inputClass, InfoBox } from "../ui";

interface Segment {
  id: string;
  name: string;
  description: string;
  definition: SegmentDefinition;
  isBuiltin: boolean;
  memberCount: number;
}

interface Preview {
  count: number;
  totalBeforeConsent: number;
  purpose: SegmentPurpose;
  sample: { id: string; name: string; phone: string | null; email: string | null }[];
}

const PURPOSE_LABELS: Record<SegmentPurpose, string> = {
  view: "فقط مشاهده",
  sms: "ارسال پیامک",
  email: "ارسال ایمیل",
};

/** A blank rule for a field, with the shape that field's `valueKind` requires. */
function blankRule(field: SegmentField): SegmentRule {
  const meta = segmentFieldMeta(field);
  const op = meta.operators[0];
  switch (meta.valueKind) {
    case "days":
      return { field, op, days: 30 } as SegmentRule;
    case "tags":
      return { field, op, values: [] } as SegmentRule;
    case "month":
      return { field, op: "is", month: 1 } as SegmentRule;
    case "boolean":
      return { field, op: "is", value: true } as SegmentRule;
    case "text":
      return { field, op: "contains", value: "" } as SegmentRule;
    default:
      return { field, op, value: 0 } as SegmentRule;
  }
}

export function SegmentsSection() {
  const money = useMoney();
  const [segments, setSegments] = useState<Segment[] | null>(null);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [editing, setEditing] = useState<Segment | "new" | null>(null);

  const load = useCallback(() => {
    api<{ segments: Segment[] }>("/api/crm/segments").then(({ ok, data }) => {
      if (ok) setSegments(data.segments);
      else setError("بارگذاری بخش‌ها ناموفق بود.");
    });
  }, []);
  useEffect(load, [load]);

  const archive = async (segment: Segment) => {
    if (!window.confirm(`«${segment.name}» بایگانی شود؟`)) return;
    const { ok, data } = await api<{ error?: string }>(`/api/crm/segments/${segment.id}`, {
      method: "DELETE",
    });
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    setInfo("بخش بایگانی شد. سابقهٔ آن برای پاسخ‌گویی دربارهٔ ارسال‌های گذشته نگه داشته می‌شود.");
    load();
  };

  return (
    <div className="min-w-0 space-y-4">
      <ErrorBox>{error}</ErrorBox>
      {info ? <InfoBox>{info}</InfoBox> : null}

      <SectionCard
        title="بخش‌بندی مشتریان"
        description="گروه‌های پویا بر پایهٔ رفتار خرید. هر بار که باز می‌شوند، دوباره محاسبه می‌شوند."
        actions={
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="icon-sm" onClick={load} aria-label="بازخوانی">
              <RefreshCwIcon aria-hidden="true" className="size-4" />
            </Button>
            <Button type="button" onClick={() => setEditing("new")}>
              <PlusIcon aria-hidden="true" className="size-4" />
              بخش جدید
            </Button>
          </div>
        }
      >
        {!segments ? (
          <LoadingSkeleton rows={3} />
        ) : segments.length === 0 ? (
          <EmptyState>
            هنوز بخشی تعریف نشده است. مثلاً «مشتریانی که بیش از ۹۰ روز خرید نکرده‌اند و مجموع خریدشان
            بالای دو میلیون تومان بوده».
          </EmptyState>
        ) : (
          <ul className="divide-y divide-stone-200/80">
            {segments.map((segment) => (
              <li key={segment.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setEditing(segment)}
                      className="font-medium text-stone-950 hover:underline"
                    >
                      {segment.name}
                    </button>
                    {segment.isBuiltin ? <StatusBadge tone="neutral">پیش‌فرض</StatusBadge> : null}
                    <StatusBadge tone="active">
                      {formatPersianNumber(segment.memberCount)} مشتری
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs leading-6 text-muted-foreground">
                    {describeSegment(segment.definition, (rial) => money.format(rial))}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => archive(segment)}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2Icon aria-hidden="true" className="size-3.5" />
                  بایگانی
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {editing ? (
        <SegmentDialog
          segment={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      ) : null}
    </div>
  );
}

function SegmentDialog({
  segment,
  onClose,
  onSaved,
}: {
  segment: Segment | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const money = useMoney();
  const [name, setName] = useState(segment?.name ?? "");
  const [description, setDescription] = useState(segment?.description ?? "");
  const [rules, setRules] = useState<SegmentRule[]>(segment?.definition.all ?? []);
  const [purpose, setPurpose] = useState<SegmentPurpose>("view");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const definition: SegmentDefinition = { all: rules };

  // Preview on every edit, debounced. The count is the whole point of the
  // builder: a rule you cannot see the effect of is a rule you write blind.
  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewLoading(true);
    const timer = setTimeout(() => {
      void api<{ preview: Preview; error?: string }>("/api/crm/segments/preview", {
        method: "POST",
        body: JSON.stringify({ definition: { all: rules }, purpose }),
      })
        .then(({ ok, data }) => {
          if (!cancelled && ok) setPreview(data.preview);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [rules, purpose]);

  const save = async () => {
    if (!name.trim()) {
      setError(errorMessage("segment_name_required"));
      return;
    }
    setBusy(true);
    setError("");
    const body = JSON.stringify({ name: name.trim(), description: description.trim(), definition });
    const { ok, data } = await api<{ error?: string }>(
      segment ? `/api/crm/segments/${segment.id}` : "/api/crm/segments",
      { method: segment ? "PATCH" : "POST", body },
    );
    setBusy(false);
    if (!ok) {
      setError(errorMessage(data.error));
      return;
    }
    onSaved();
  };

  const updateRule = (index: number, next: SegmentRule) =>
    setRules((current) => current.map((rule, i) => (i === index ? next : rule)));

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{segment ? `ویرایش ${segment.name}` : "بخش جدید"}</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <Field label="نام بخش">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="توضیح (اختیاری)">
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <div className="mb-4">
          <p className="mb-2 text-sm font-medium text-foreground">قاعده‌ها (همه باید برقرار باشند)</p>
          {rules.length === 0 ? (
            <p className="mb-2 text-xs text-muted-foreground">
              بدون قاعده، این بخش همهٔ مشتریان را شامل می‌شود.
            </p>
          ) : null}
          <div className="space-y-2">
            {rules.map((rule, index) => (
              <RuleRow
                key={index}
                rule={rule}
                onChange={(next) => updateRule(index, next)}
                onRemove={() => setRules((current) => current.filter((_, i) => i !== index))}
              />
            ))}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => setRules((current) => [...current, blankRule("lastPurchaseAt")])}
          >
            <PlusIcon aria-hidden="true" className="size-4" />
            افزودن قاعده
          </Button>
        </div>

        <Field label="این بخش برای چه کاری است؟" hint="فیلتر رضایت ارتباط بر همین اساس اعمال می‌شود.">
          <select
            className={inputClass}
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as SegmentPurpose)}
          >
            {(Object.keys(PURPOSE_LABELS) as SegmentPurpose[]).map((key) => (
              <option key={key} value={key}>
                {PURPOSE_LABELS[key]}
              </option>
            ))}
          </select>
        </Field>

        <div className="rounded-2xl border border-stone-200/80 bg-stone-50/60 p-4">
          <p className="text-sm font-medium text-stone-950">برآورد</p>
          {previewLoading ? (
            <LoadingSkeleton rows={2} compact className="mt-2" label="در حال محاسبه برآورد بخش" />
          ) : !preview ? (
            <p className="mt-1 text-xs text-muted-foreground">برآورد این بخش در دسترس نیست.</p>
          ) : (
            <>
              <p className="mt-1 text-sm text-stone-700">
                {purpose === "view" ? (
                  <>{formatPersianNumber(preview.count)} مشتری در این بخش قرار می‌گیرند.</>
                ) : (
                  <>
                    {formatPersianNumber(preview.totalBeforeConsent)} مشتری با این قاعده‌ها هم‌خوانی
                    دارند؛ از این میان{" "}
                    <span className="font-semibold text-teal-700">
                      {formatPersianNumber(preview.count)} نفر
                    </span>{" "}
                    اجازهٔ {PURPOSE_LABELS[purpose]} داده‌اند و راه ارتباطی‌شان ثبت است.
                  </>
                )}
              </p>
              <p className="mt-1 text-xs leading-6 text-muted-foreground">
                {describeSegment(definition, (rial) => money.format(rial))}
              </p>
              {preview.sample.length > 0 ? (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {preview.sample.slice(0, 8).map((member) => (
                    <li key={member.id}>
                      <StatusBadge tone="neutral">{member.name}</StatusBadge>
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={save} disabled={busy}>
            ذخیره
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One rule: field, operator, and whatever value shape that field needs. */
function RuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: SegmentRule;
  onChange: (next: SegmentRule) => void;
  onRemove: () => void;
}) {
  const meta = segmentFieldMeta(rule.field);
  const money = useMoney();

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200/80 p-2">
      <select
        className={`${inputClass} w-40`}
        value={rule.field}
        onChange={(e) => onChange(blankRule(e.target.value as SegmentField))}
        aria-label="فیلد"
      >
        {SEGMENT_FIELDS.map((field) => (
          <option key={field.field} value={field.field}>
            {field.label}
          </option>
        ))}
      </select>

      <select
        className={`${inputClass} w-36`}
        value={rule.op}
        onChange={(e) => onChange({ ...rule, op: e.target.value } as SegmentRule)}
        aria-label="شرط"
      >
        {meta.operators.map((op) => (
          <option key={op} value={op}>
            {SEGMENT_OPERATOR_LABELS[op] ?? op}
          </option>
        ))}
      </select>

      <RuleValue rule={rule} meta={meta} onChange={onChange} money={money} />

      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onRemove}
        aria-label="حذف قاعده"
        className="ms-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
      >
        <Trash2Icon aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}

function RuleValue({
  rule,
  meta,
  onChange,
  money,
}: {
  rule: SegmentRule;
  meta: ReturnType<typeof segmentFieldMeta>;
  onChange: (next: SegmentRule) => void;
  money: ReturnType<typeof useMoney>;
}) {
  // Persian digits are accepted everywhere a number is typed: the keyboard the
  // user has is the one they will use.
  const asNumber = (raw: string) => Number(toLatinDigits(raw).replace(/[^\d-]/g, "")) || 0;

  switch (meta.valueKind) {
    case "days":
      return (
        <label className="flex items-center gap-1.5 text-sm text-stone-600">
          <input
            className={`${inputClass} w-24`}
            value={toPersianDigits(String((rule as { days: number }).days))}
            onChange={(e) => onChange({ ...rule, days: asNumber(e.target.value) } as SegmentRule)}
            aria-label="تعداد روز"
          />
          روز
        </label>
      );
    case "money":
      // Rules store integer Rial; the owner types in the business's own unit.
      // Converting here — the one place the two meet — is why a «۲٬۰۰۰٬۰۰۰
      // تومان» rule does not quietly become two million *Rial*.
      return (
        <label className="flex items-center gap-1.5 text-sm text-stone-600">
          <input
            className={`${inputClass} w-32`}
            value={toPersianDigits(String(money.toInput((rule as { value: number }).value)))}
            onChange={(e) =>
              onChange({ ...rule, value: money.fromInput(asNumber(e.target.value)) } as SegmentRule)
            }
            aria-label="مبلغ"
          />
          {money.unitLabel}
        </label>
      );
    case "number":
      return (
        <input
          className={`${inputClass} w-24`}
          value={toPersianDigits(String((rule as { value: number }).value))}
          onChange={(e) => onChange({ ...rule, value: asNumber(e.target.value) } as SegmentRule)}
          aria-label="مقدار"
        />
      );
    case "month":
      return (
        <input
          className={`${inputClass} w-20`}
          value={toPersianDigits(String((rule as { month: number }).month))}
          onChange={(e) => onChange({ ...rule, month: asNumber(e.target.value) } as SegmentRule)}
          aria-label="ماه"
        />
      );
    case "boolean":
      return (
        <select
          className={`${inputClass} w-28`}
          value={(rule as { value: boolean }).value ? "1" : "0"}
          onChange={(e) => onChange({ ...rule, value: e.target.value === "1" } as SegmentRule)}
          aria-label="بله یا خیر"
        >
          <option value="1">بله</option>
          <option value="0">خیر</option>
        </select>
      );
    case "tags":
      return (
        <input
          className={`${inputClass} w-52`}
          placeholder="برچسب‌ها با ویرگول"
          value={(rule as { values: string[] }).values.join("، ")}
          onChange={(e) =>
            onChange({
              ...rule,
              values: e.target.value
                .split(/[،,]/)
                .map((tag) => tag.trim())
                .filter(Boolean),
            } as SegmentRule)
          }
          aria-label="برچسب‌ها"
        />
      );
    default:
      return (
        <input
          className={`${inputClass} w-52`}
          value={String((rule as { value: string }).value ?? "")}
          onChange={(e) => onChange({ ...rule, value: e.target.value } as SegmentRule)}
          aria-label="متن"
        />
      );
  }
}
