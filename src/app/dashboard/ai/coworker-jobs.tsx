"use client";

import { LoadingSkeleton } from "@/app/dashboard/page-chrome";

import { PersianNumberInput } from "@/components/ui/persian-number-input";
/**
 * Phase 32 — defining a job: pick a ready-made template, say when it should
 * run, and say whether the coworker may act or must ask.
 *
 * The form is per-template because the *decisions* are: "which item, and all of
 * it or a fixed amount" is what a waste job needs, and asking that of a
 * production job would be nonsense. `template.params` drives which editor
 * appears, so adding a template adds its form with no change here.
 */
import { useCallback, useEffect, useState } from "react";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useFeatureLocked } from "@/components/feature-lock";
import {
  COWORKER_APPROVAL_LABELS,
  COWORKER_EVENT_LABELS,
  COWORKER_WEEKDAYS,
  coworkerTriggerSummary,
  type CoworkerApprovalMode,
  type CoworkerEventKind,
  type CoworkerTriggerKind,
} from "@/lib/ai-coworker";
import type { CoworkerTemplate } from "@/lib/ai-coworker-templates";
import { EmptyState, SectionCard, StatusBadge } from "../page-chrome";
import { Field, inputClass } from "../ui";
import type { CoworkerCatalogue, CoworkerJobView } from "./coworker-types";
import { formatDateTime } from "./format";

interface WasteLine {
  inventoryItemId: string;
  mode: "remaining" | "fixed";
  quantity: string;
  reason: string;
}
interface FormulaLine {
  formulaId: string;
  batches: string;
}
interface TopUpLine {
  inventoryItemId: string;
  purchaseQty: string;
  totalCostRial: string;
}

/**
 * Patch one row of a per-template line list (waste items, formula runs,
 * stock top-ups) — the single map-and-match every line editor used to
 * re-spell for each of its fields.
 */
function patchLine<T>(
  setLines: React.Dispatch<React.SetStateAction<T[]>>,
  index: number,
  patch: Partial<T>,
) {
  setLines((lines) => lines.map((row, i) => (i === index ? { ...row, ...patch } : row)));
}

export function CoworkerJobs({ canAutoApply, onChange }: { canAutoApply: boolean; onChange?: () => void }) {
  const locked = useFeatureLocked();
  const [catalogue, setCatalogue] = useState<CoworkerCatalogue | null>(null);
  const [jobs, setJobs] = useState<CoworkerJobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [draftTemplate, setDraftTemplate] = useState<CoworkerTemplate | null>(null);
  const [title, setTitle] = useState("");
  const [locationId, setLocationId] = useState("");
  const [triggerKind, setTriggerKind] = useState<CoworkerTriggerKind>("event");
  const [eventKind, setEventKind] = useState<CoworkerEventKind>("shift_close");
  const [scheduleHour, setScheduleHour] = useState("8");
  const [scheduleWeekday, setScheduleWeekday] = useState("");
  const [approvalMode, setApprovalMode] = useState<CoworkerApprovalMode>("ask");
  const [note, setNote] = useState("");
  const [minSeverity, setMinSeverity] = useState("medium");
  const [messageChannel, setMessageChannel] = useState<"sms" | "email">("sms");
  const [messageTemplateId, setMessageTemplateId] = useState("");
  const [messageProjectId, setMessageProjectId] = useState("");
  const [wasteLines, setWasteLines] = useState<WasteLine[]>([]);
  const [formulaLines, setFormulaLines] = useState<FormulaLine[]>([]);
  const [topUpLines, setTopUpLines] = useState<TopUpLine[]>([]);

  const load = useCallback(async () => {
    try {
      const [catalogueResponse, jobsResponse] = await Promise.all([
        fetch("/api/ai/coworker/templates"),
        fetch("/api/ai/coworker/jobs"),
      ]);
      const catalogueBody = (await catalogueResponse.json().catch(() => ({}))) as Partial<CoworkerCatalogue>;
      const jobsBody = (await jobsResponse.json().catch(() => ({}))) as { jobs?: CoworkerJobView[] };
      if (!catalogueResponse.ok || !jobsResponse.ok) throw new Error("خواندن کارهای همکار هوشمند ممکن نشد.");
      setCatalogue(catalogueBody as CoworkerCatalogue);
      setJobs(jobsBody.jobs ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "خواندن کارهای همکار هوشمند ممکن نشد.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (locked) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, locked]);

  function startDraft(template: CoworkerTemplate) {
    setDraftTemplate(template);
    setTitle(template.title);
    setLocationId("");
    setTriggerKind(template.suggestedTrigger);
    if (template.suggestedEvent) setEventKind(template.suggestedEvent);
    setScheduleHour(String(template.suggestedHour ?? 8));
    setScheduleWeekday("");
    setApprovalMode("ask");
    setNote("");
    setMinSeverity("medium");
    setMessageChannel("sms"); setMessageTemplateId(""); setMessageProjectId("");
    setWasteLines([{ inventoryItemId: "", mode: "remaining", quantity: "", reason: "spoilage" }]);
    setFormulaLines([{ formulaId: "", batches: "1" }]);
    setTopUpLines([{ inventoryItemId: "", purchaseQty: "", totalCostRial: "" }]);
  }

  function buildParams(): Record<string, unknown> {
    if (!draftTemplate) return {};
    switch (draftTemplate.key) {
      case "shift_close_waste":
        return {
          note: note || undefined,
          items: wasteLines
            .filter((line) => line.inventoryItemId)
            .map((line) => ({
              inventoryItemId: line.inventoryItemId,
              mode: line.mode,
              reason: line.reason,
              ...(line.mode === "fixed" ? { quantity: line.quantity } : {}),
            })),
        };
      case "shift_open_production":
        return {
          note: note || undefined,
          runs: formulaLines
            .filter((line) => line.formulaId)
            .map((line) => ({ formulaId: line.formulaId, batches: line.batches })),
        };
      case "shift_open_stock_topup":
        return {
          note: note || undefined,
          lines: topUpLines
            .filter((line) => line.inventoryItemId)
            .map((line) => ({
              inventoryItemId: line.inventoryItemId,
              purchaseQty: line.purchaseQty,
              totalCostRial: Number(line.totalCostRial),
            })),
        };
      case "low_stock_purchase_draft":
        return { note: note || undefined };
      case "accounting_review":
        return { minSeverity };
      case "customer_event_message":
        return { channel: messageChannel, templateId: messageTemplateId, ...(messageProjectId ? { projectId: messageProjectId } : {}) };
    }
  }

  async function save() {
    if (!draftTemplate) return;
    setSaving(true);
    try {
      const response = await fetch("/api/ai/coworker/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateKey: draftTemplate.key,
          title,
          locationId: locationId || null,
          triggerKind,
          eventKind: triggerKind === "event" ? eventKind : null,
          scheduleHour: triggerKind === "schedule" ? Number(scheduleHour) : null,
          scheduleWeekday: triggerKind === "schedule" && scheduleWeekday ? Number(scheduleWeekday) : null,
          params: buildParams(),
          approvalMode,
          enabled: true,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { messages?: string[]; error?: string };
      if (!response.ok) throw new Error(body.messages?.[0] ?? body.error ?? "ثبت این کار ممکن نشد.");
      toast.success("کار جدید به همکار هوشمند سپرده شد.");
      setDraftTemplate(null);
      await load();
      onChange?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ثبت این کار ممکن نشد.");
    } finally {
      setSaving(false);
    }
  }

  async function toggle(job: CoworkerJobView) {
    setBusyId(job.id);
    try {
      const response = await fetch(`/api/ai/coworker/jobs/${job.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !job.enabled }),
      });
      if (!response.ok) throw new Error("تغییر وضعیت این کار ممکن نشد.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "تغییر وضعیت این کار ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(job: CoworkerJobView) {
    setBusyId(job.id);
    try {
      const response = await fetch(`/api/ai/coworker/jobs/${job.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("حذف این کار ممکن نشد.");
      toast.success("کار حذف شد.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "حذف این کار ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  async function runNow(job: CoworkerJobView) {
    setBusyId(job.id);
    try {
      const response = await fetch(`/api/ai/coworker/jobs/${job.id}/run`, { method: "POST" });
      if (!response.ok) throw new Error("اجرای این کار ممکن نشد.");
      toast.success("اجرا شد — نتیجه را در «در انتظار تأیید» ببینید.");
      await load();
      onChange?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "اجرای این کار ممکن نشد.");
    } finally {
      setBusyId(null);
    }
  }

  const items = catalogue?.options.inventoryItems ?? [];
  const formulas = catalogue?.options.formulas ?? [];
  const branches = catalogue?.options.branches ?? [];
  const reasons = catalogue?.labels.wasteReasons ?? [];

  return (
    <div className="space-y-4">
      <SectionCard title="کارهای سپرده‌شده" description="کارهایی که همکار هوشمند برای شما انجام می‌دهد." flush>
        {loading ? (
          <div className="p-4 sm:p-5"><LoadingSkeleton rows={4} /></div>
        ) : jobs.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز کاری به همکار هوشمند نسپرده‌اید. از پایین یکی را انتخاب کنید.</EmptyState>
          </div>
        ) : (
          <ul className="divide-y divide-border/80">
            {jobs.map((job) => (
              <li key={job.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-foreground">{job.title}</span>
                    <StatusBadge tone={job.enabled ? "positive" : "neutral"}>
                      {job.enabled ? "فعال" : "خاموش"}
                    </StatusBadge>
                    <StatusBadge tone={job.approvalMode === "auto" ? "active" : "neutral"}>
                      {COWORKER_APPROVAL_LABELS[job.approvalMode]}
                    </StatusBadge>
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{coworkerTriggerSummary(job)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">آخرین اجرا: {formatDateTime(job.lastRunAt)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => void runNow(job)} disabled={busyId === job.id}>
                    <PlayIcon className="size-4" />
                    اجرای فوری
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void toggle(job)} disabled={busyId === job.id}>
                    {job.enabled ? "خاموش" : "روشن"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void remove(job)} disabled={busyId === job.id}>
                    <Trash2Icon className="size-4 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="یک کار تازه بسپارید"
        description="قالب‌های آماده. هرکدام را انتخاب کنید، جزئیاتش را بگویید و بقیه با همکار هوشمند است."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {(catalogue?.templates ?? []).map((template) => (
            <button
              key={template.key}
              type="button"
              onClick={() => startDraft(template)}
              className={`rounded-xl border p-3 text-right transition ${
                draftTemplate?.key === template.key
                  ? "border-amber-300 dark:border-amber-500/40 bg-amber-100 dark:bg-amber-500/20 text-amber-950 dark:text-amber-200"
                  : "border-border/80 hover:bg-muted"
              }`}
            >
              <span className="block text-sm font-medium">{template.title}</span>
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{template.description}</span>
            </button>
          ))}
        </div>

        {draftTemplate ? (
          <div className="mt-4 space-y-4 rounded-xl border border-border/80 p-4">
            <Field label="عنوان این کار">
              <input className={inputClass} value={title} onChange={(event) => setTitle(event.target.value)} />
            </Field>

            {draftTemplate.scope === "location" && branches.length > 1 ? (
              <Field label="شعبه">
                <select
                  className={inputClass}
                  value={locationId}
                  onChange={(event) => setLocationId(event.target.value)}
                >
                  <option value="">همهٔ شعبه‌ها</option>
                  {branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            <Field label="چه زمانی اجرا شود؟">
              <select
                className={inputClass}
                value={triggerKind}
                onChange={(event) => setTriggerKind(event.target.value as CoworkerTriggerKind)}
              >
                {draftTemplate.triggers.map((trigger) => (
                  <option key={trigger} value={trigger}>
                    {catalogue?.labels.triggers[trigger] ?? trigger}
                  </option>
                ))}
              </select>
            </Field>

            {triggerKind === "event" ? (
              <Field label="با کدام رویداد؟">
                <select
                  className={inputClass}
                  value={eventKind}
                  onChange={(event) => setEventKind(event.target.value as CoworkerEventKind)}
                >
                  {Object.entries(COWORKER_EVENT_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : null}

            {triggerKind === "schedule" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="ساعت (۰ تا ۲۳)">
                  <PersianNumberInput
                    className={inputClass}
                    inputMode="numeric"
                    value={scheduleHour}
                    onChange={(event) => setScheduleHour(event.target.value)}
                  />
                </Field>
                <Field label="روز هفته">
                  <select
                    className={inputClass}
                    value={scheduleWeekday}
                    onChange={(event) => setScheduleWeekday(event.target.value)}
                  >
                    {COWORKER_WEEKDAYS.map((day) => (
                      <option key={day.value} value={day.value}>
                        {day.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            ) : null}

            {draftTemplate.key === "shift_close_waste" ? (
              <div className="space-y-2">
                <span className="text-sm font-medium text-foreground">کالاها و دلیل ضایعات</span>
                {wasteLines.map((line, index) => (
                  <div key={index} className="grid gap-2 sm:grid-cols-4">
                    <select
                      className={inputClass}
                      value={line.inventoryItemId}
                      onChange={(event) =>
                        patchLine(setWasteLines, index, { inventoryItemId: event.target.value })
                      }
                    >
                      <option value="">انتخاب کالا…</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <select
                      className={inputClass}
                      value={line.mode}
                      onChange={(event) =>
                        patchLine(setWasteLines, index, {
                          mode: event.target.value as "remaining" | "fixed",
                        })
                      }
                    >
                      <option value="remaining">هرچه مانده</option>
                      <option value="fixed">مقدار ثابت</option>
                    </select>
                    <PersianNumberInput inputMode="decimal"
                      className={inputClass}
                      placeholder="مقدار"
                      disabled={line.mode !== "fixed"}
                      value={line.quantity}
                      onChange={(event) =>
                        patchLine(setWasteLines, index, { quantity: event.target.value })
                      }
                    />
                    <select
                      className={inputClass}
                      value={line.reason}
                      onChange={(event) =>
                        patchLine(setWasteLines, index, { reason: event.target.value })
                      }
                    >
                      {reasons.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setWasteLines((lines) => [
                      ...lines,
                      { inventoryItemId: "", mode: "remaining", quantity: "", reason: "spoilage" },
                    ])
                  }
                >
                  <PlusIcon className="size-4" />
                  کالای دیگر
                </Button>
              </div>
            ) : null}

            {draftTemplate.key === "shift_open_production" ? (
              <div className="space-y-2">
                <span className="text-sm font-medium text-foreground">فرمول‌ها و تعداد بچ</span>
                {formulaLines.map((line, index) => (
                  <div key={index} className="grid gap-2 sm:grid-cols-2">
                    <select
                      className={inputClass}
                      value={line.formulaId}
                      onChange={(event) =>
                        patchLine(setFormulaLines, index, { formulaId: event.target.value })
                      }
                    >
                      <option value="">انتخاب فرمول…</option>
                      {formulas.map((formula) => (
                        <option key={formula.id} value={formula.id}>
                          {formula.name} ← {formula.outputName}
                        </option>
                      ))}
                    </select>
                    <PersianNumberInput inputMode="decimal"
                      className={inputClass}
                      placeholder="تعداد بچ"
                      value={line.batches}
                      onChange={(event) =>
                        patchLine(setFormulaLines, index, { batches: event.target.value })
                      }
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setFormulaLines((lines) => [...lines, { formulaId: "", batches: "1" }])}
                >
                  <PlusIcon className="size-4" />
                  فرمول دیگر
                </Button>
              </div>
            ) : null}

            {draftTemplate.key === "shift_open_stock_topup" ? (
              <div className="space-y-2">
                <span className="text-sm font-medium text-foreground">کالاها، مقدار و بهای هر بار</span>
                {topUpLines.map((line, index) => (
                  <div key={index} className="grid gap-2 sm:grid-cols-3">
                    <select
                      className={inputClass}
                      value={line.inventoryItemId}
                      onChange={(event) =>
                        patchLine(setTopUpLines, index, { inventoryItemId: event.target.value })
                      }
                    >
                      <option value="">انتخاب کالا…</option>
                      {items.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                    <PersianNumberInput inputMode="decimal"
                      className={inputClass}
                      placeholder="مقدار در واحد خرید"
                      value={line.purchaseQty}
                      onChange={(event) =>
                        patchLine(setTopUpLines, index, { purchaseQty: event.target.value })
                      }
                    />
                    <PersianNumberInput
                      className={inputClass}
                      placeholder="مبلغ کل (ریال)"
                      inputMode="numeric"
                      value={line.totalCostRial}
                      onChange={(event) =>
                        patchLine(setTopUpLines, index, { totalCostRial: event.target.value })
                      }
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setTopUpLines((lines) => [...lines, { inventoryItemId: "", purchaseQty: "", totalCostRial: "" }])
                  }
                >
                  <PlusIcon className="size-4" />
                  کالای دیگر
                </Button>
              </div>
            ) : null}

            {draftTemplate.key === "customer_event_message" ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="کانال"><select className={inputClass} value={messageChannel} onChange={(event) => { setMessageChannel(event.target.value as "sms" | "email"); setMessageTemplateId(""); }}><option value="sms">پیامک</option><option value="email">ایمیل</option></select></Field>
                <Field label="الگوی پیام"><select className={inputClass} value={messageTemplateId} onChange={(event) => setMessageTemplateId(event.target.value)} required><option value="">انتخاب الگو</option>{(catalogue?.options.messageTemplates ?? []).filter((template) => template.channel === messageChannel).map((template) => <option value={template.id} key={template.id}>{template.name}</option>)}</select></Field>
                <Field label="پروژه / مرکز هزینه (اختیاری)"><select className={inputClass} value={messageProjectId} onChange={(event) => setMessageProjectId(event.target.value)}><option value="">بدون پروژه</option>{(catalogue?.options.projects ?? []).map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></Field>
              </div>
            ) : null}

            {draftTemplate.key === "accounting_review" ? (
              <Field label="کمترین درجهٔ اهمیت برای گزارش">
                <select
                  className={inputClass}
                  value={minSeverity}
                  onChange={(event) => setMinSeverity(event.target.value)}
                >
                  <option value="high">فقط موارد بحرانی</option>
                  <option value="medium">بحرانی و مهم</option>
                  <option value="low">همهٔ موارد</option>
                </select>
              </Field>
            ) : null}

            {draftTemplate.key !== "accounting_review" && draftTemplate.key !== "customer_event_message" ? (
              <Field label="یادداشت (اختیاری)">
                <input className={inputClass} value={note} onChange={(event) => setNote(event.target.value)} />
              </Field>
            ) : null}

            {draftTemplate.emits.length > 0 ? (
              <Field label="قبل از ثبت چه کند؟">
                <select
                  className={inputClass}
                  value={approvalMode}
                  onChange={(event) => setApprovalMode(event.target.value as CoworkerApprovalMode)}
                >
                  <option value="ask">{COWORKER_APPROVAL_LABELS.ask}</option>
                  {/* Only the Owner may pre-approve an unattended write, the
                      same rule the autopilot money category follows. */}
                  {canAutoApply ? <option value="auto">{COWORKER_APPROVAL_LABELS.auto}</option> : null}
                </select>
              </Field>
            ) : null}

            {approvalMode === "auto" ? (
              <p className="text-xs leading-5 text-amber-800 dark:text-amber-300">
                حتی در این حالت، هر اقدام از سقف‌های «اجرای خودکار» شما رد می‌شود؛ هرچه از سقف بگذرد باز هم برای
                تأیید شما کنار گذاشته می‌شود.
              </p>
            ) : null}

            <div className="flex items-center gap-2">
              <Button onClick={() => void save()} disabled={saving}>
                {saving ? "در حال سپردن…" : "سپردن این کار"}
              </Button>
              <Button variant="outline" onClick={() => setDraftTemplate(null)} disabled={saving}>
                انصراف
              </Button>
            </div>
          </div>
        ) : null}
      </SectionCard>
    </div>
  );
}
