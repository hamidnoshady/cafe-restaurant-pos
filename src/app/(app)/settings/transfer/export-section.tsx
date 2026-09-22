"use client";

/**
 * «خروجی گرفتن» — the export builder plus the scheduled exports beside it.
 *
 * The builder is three choices: what, which columns, which format. Filters sit
 * under the field chooser because they are the thing people forget and then
 * blame the export for — a date range that quietly said "everything" is how a
 * 90,000-row spreadsheet arrives in somebody's inbox.
 *
 * Two things are deliberately *not* options:
 *
 *  - the produced file is always human-readable (a category is its name, a
 *    date is Shamsi, money is the business's own unit and the column says so);
 *  - every export is recorded in the history and kept for a retention window,
 *    so it can be downloaded again without re-running it against data that has
 *    moved.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClockIcon, DownloadIcon, SaveIcon, Trash2Icon } from "lucide-react";
import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/app/dashboard/page-chrome";
import {
  DataTable,
  DataTableBody,
  DataTableHead,
  DataTableRow,
  Td,
  Th,
} from "@/app/dashboard/data-table";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  inputClass,
} from "@/app/dashboard/ui";
import { toPersianDigits } from "@/lib/digits";
import { EXPORT_FORMAT_LABELS, FREQUENCY_LABELS, WEEKDAY_LABELS } from "@/lib/data-transfer/types";
import {
  DateField,
  JalaliCell,
  SelectField,
  dataError,
  groupByModule,
  type CatalogueEntity,
  type ScheduleView,
} from "./data-transfer-ui";

interface ExportTemplateView {
  id: string;
  entityKey: string;
  name: string;
  format: string;
  fields: string[];
  filters: Record<string, unknown>;
}

const FORMATS = ["xlsx", "csv", "pdf", "json"] as const;

export function ExportSection({
  entities,
  onExported,
}: {
  entities: CatalogueEntity[] | null;
  onExported: () => void;
}) {
  const exportable = useMemo(
    () => (entities ?? []).filter((entity) => entity.canExport),
    [entities],
  );
  const groups = useMemo(() => groupByModule(exportable), [exportable]);

  const [entityKey, setEntityKey] = useState("");
  const [format, setFormat] = useState<string>("xlsx");
  const [selected, setSelected] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [activeOnly, setActiveOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [templates, setTemplates] = useState<ExportTemplateView[]>([]);
  const [templateName, setTemplateName] = useState("");
  const [schedules, setSchedules] = useState<ScheduleView[] | null>(null);
  const [scheduleName, setScheduleName] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [hourLocal, setHourLocal] = useState("7");
  const [weekday, setWeekday] = useState("0");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [deliverEmail, setDeliverEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const entity = useMemo(
    () => exportable.find((candidate) => candidate.key === entityKey) ?? null,
    [exportable, entityKey],
  );

  useEffect(() => {
    if (!entity) {
      setSelected([]);
      setTemplates([]);
      return;
    }
    setSelected(entity.defaultExportFields);
    api<{ templates: ExportTemplateView[] }>(
      `/api/data/templates?kind=export&entity=${encodeURIComponent(entity.key)}`,
    ).then(({ ok, data }) => setTemplates(ok ? data.templates : []));
  }, [entity]);

  const loadSchedules = useCallback(() => {
    api<{ schedules: ScheduleView[] }>("/api/data/schedules").then(({ ok, data }) =>
      setSchedules(ok ? data.schedules : []),
    );
  }, []);

  useEffect(loadSchedules, [loadSchedules]);

  function filters(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (dateFrom) out.dateFrom = dateFrom;
    if (dateTo) out.dateTo = dateTo;
    if (activeOnly) out.activeOnly = true;
    if (search.trim()) out.search = search.trim();
    return out;
  }

  /**
   * Download through a blob rather than a plain link: the route answers a POST
   * (a body-carrying field/filter selection is not a URL), and the filename
   * comes back RFC 5987-encoded in the header.
   */
  async function runExport() {
    if (!entity) {
      setError("ابتدا نوع داده را انتخاب کنید.");
      return;
    }
    if (selected.length === 0) {
      setError(dataError("no_fields"));
      return;
    }
    setBusy("export");
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/data/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: entity.key,
          format,
          fields: selected,
          filters: filters(),
        }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setError(dataError(payload.error));
        return;
      }
      const blob = await response.blob();
      const rowCount = response.headers.get("X-Row-Count") ?? "0";
      triggerDownload(blob, fileNameFrom(response.headers.get("Content-Disposition"), entity.label, format));
      setNotice(`خروجی با ${toPersianDigits(rowCount)} سطر آماده و در تاریخچه ذخیره شد.`);
      onExported();
    } catch {
      setError(dataError("network_error"));
    } finally {
      setBusy(null);
    }
  }

  async function saveTemplate() {
    if (!entity || !templateName.trim()) {
      setError("برای ذخیرهٔ قالب، نامی برای آن وارد کنید.");
      return;
    }
    setBusy("template");
    const { ok, data } = await api<{ template: ExportTemplateView; error?: string }>(
      "/api/data/templates",
      {
        method: "POST",
        body: JSON.stringify({
          kind: "export",
          entity: entity.key,
          name: templateName.trim(),
          format,
          fields: selected,
          filters: filters(),
        }),
      },
    );
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    setTemplates((current) => [...current, data.template]);
    setTemplateName("");
    setNotice(`قالب خروجی «${data.template.name}» ذخیره شد.`);
  }

  function applyTemplate(id: string) {
    const template = templates.find((candidate) => candidate.id === id);
    if (!template) return;
    setFormat(template.format);
    setSelected(template.fields);
    const templateFilters = template.filters ?? {};
    setDateFrom(typeof templateFilters.dateFrom === "string" ? templateFilters.dateFrom : "");
    setDateTo(typeof templateFilters.dateTo === "string" ? templateFilters.dateTo : "");
    setActiveOnly(templateFilters.activeOnly === true);
  }

  async function createSchedule() {
    if (!entity || !scheduleName.trim()) {
      setError("برای زمان‌بندی، نامی برای آن وارد کنید.");
      return;
    }
    setBusy("schedule");
    const { ok, data } = await api<{ schedule: ScheduleView; error?: string }>(
      "/api/data/schedules",
      {
        method: "POST",
        body: JSON.stringify({
          entity: entity.key,
          name: scheduleName.trim(),
          format,
          frequency,
          hourLocal: Number(hourLocal),
          weekday: frequency === "weekly" ? Number(weekday) : null,
          dayOfMonth: frequency === "monthly" ? Number(dayOfMonth) : null,
          fields: selected,
          filters: filters(),
          deliverEmail: deliverEmail.trim(),
          deliverStore: true,
        }),
      },
    );
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    setScheduleName("");
    setDeliverEmail("");
    setNotice(`زمان‌بندی «${data.schedule.name}» ساخته شد.`);
    loadSchedules();
  }

  async function runSchedule(id: string) {
    setBusy(`run-${id}`);
    const { ok, data } = await api<{ rowCount?: number; error?: string }>(
      `/api/data/schedules/${id}`,
      { method: "POST" },
    );
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    setNotice(`خروجی زمان‌بندی‌شده با ${toPersianDigits(data.rowCount ?? 0)} سطر ساخته شد.`);
    loadSchedules();
    onExported();
  }

  async function removeSchedule(id: string) {
    setBusy(`delete-${id}`);
    const { ok, data } = await api<{ error?: string }>(`/api/data/schedules/${id}`, {
      method: "DELETE",
    });
    setBusy(null);
    if (!ok) {
      setError(dataError(data.error));
      return;
    }
    loadSchedules();
  }

  if (entities === null) return <LoadingSkeleton rows={6} />;

  if (exportable.length === 0) {
    return (
      <SectionCard title="خروجی گرفتن">
        <EmptyState icon={DownloadIcon} title="برای هیچ نوع داده‌ای دسترسی خروجی ندارید">
          خروجی گرفتن به مجوز «خروجی داده» و مجوز همان بخش نیاز دارد.
        </EmptyState>
      </SectionCard>
    );
  }

  return (
    <div className="space-y-6">
      {error ? <ErrorBox>{error}</ErrorBox> : null}
      {notice ? <InfoBox>{notice}</InfoBox> : null}

      <SectionCard
        title="ساخت خروجی"
        description="نوع داده، ستون‌ها و قالب فایل را انتخاب کنید. مقادیر همیشه خوانا خارج می‌شوند؛ مثلاً نام دسته، نه شمارهٔ آن."
      >
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="نوع داده">
            <select
              className={inputClass}
              value={entityKey}
              onChange={(event) => setEntityKey(event.target.value)}
            >
              <option value="">— انتخاب کنید —</option>
              {groups.map((group) => (
                <optgroup key={group.module} label={group.label}>
                  {group.entities.map((candidate) => (
                    <option key={candidate.key} value={candidate.key}>
                      {candidate.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </Field>
          <SelectField
            label="قالب فایل"
            value={format}
            onChange={setFormat}
            options={FORMATS.map((value) => ({ value, label: EXPORT_FORMAT_LABELS[value] }))}
            hint="JSON برای اتصال به نرم‌افزار دیگر؛ بقیه برای خواندن آدم‌ها."
          />
        </div>

        {templates.length > 0 ? (
          <SelectField
            label="قالب ذخیره‌شده"
            value=""
            onChange={applyTemplate}
            options={[
              { value: "", label: "— انتخاب برای اعمال —" },
              ...templates.map((template) => ({ value: template.id, label: template.name })),
            ]}
          />
        ) : null}

        {entity ? (
          <>
            <Field
              label="ستون‌های خروجی"
              hint="فقط ستون‌های تیک‌خورده در فایل می‌آیند."
              as="div"
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {entity.fields.map((field) => (
                  <label key={field.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(field.key)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, field.key]
                            : current.filter((key) => key !== field.key),
                        )
                      }
                    />
                    <span>{field.label}</span>
                  </label>
                ))}
              </div>
            </Field>

            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
              <DateField label="از تاریخ" value={dateFrom} onChange={setDateFrom} />
              <DateField label="تا تاریخ" value={dateTo} onChange={setDateTo} />
              <Field label="جست‌وجو" hint="فیلتر متنی روی نام رکوردها.">
                <input
                  className={inputClass}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </Field>
              <Field label="محدودسازی" as="div">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={activeOnly}
                    onChange={(event) => setActiveOnly(event.target.checked)}
                  />
                  <span>فقط رکوردهای فعال</span>
                </label>
              </Field>
            </div>

            <div className="flex flex-wrap items-end gap-3">
              <PrimaryButton onClick={runExport} disabled={busy !== null || selected.length === 0}>
                <DownloadIcon className="size-4" aria-hidden="true" />
                {busy === "export" ? "در حال ساخت…" : "ساخت و دانلود خروجی"}
              </PrimaryButton>
              <div className="min-w-60 grow">
                <Field label="ذخیره به‌عنوان قالب خروجی">
                  <input
                    className={inputClass}
                    value={templateName}
                    onChange={(event) => setTemplateName(event.target.value)}
                    placeholder="مثلاً گزارش ماهانهٔ مشتریان"
                  />
                </Field>
              </div>
              <SecondaryButton
                onClick={saveTemplate}
                disabled={busy !== null || !templateName.trim()}
              >
                <SaveIcon className="size-4" aria-hidden="true" />
                ذخیرهٔ قالب
              </SecondaryButton>
            </div>
          </>
        ) : null}
      </SectionCard>

      {entity ? (
        <SectionCard
          title="زمان‌بندی خروجی"
          description="خروجی همین تنظیمات به‌صورت خودکار ساخته و در صورت تمایل ایمیل می‌شود. ساعت بر اساس ساعت محلی کسب‌وکار است."
        >
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            <Field label="نام زمان‌بندی">
              <input
                className={inputClass}
                value={scheduleName}
                onChange={(event) => setScheduleName(event.target.value)}
                placeholder="مثلاً فروش روزانه"
              />
            </Field>
            <SelectField
              label="تناوب"
              value={frequency}
              onChange={setFrequency}
              options={(["daily", "weekly", "monthly"] as const).map((value) => ({
                value,
                label: FREQUENCY_LABELS[value],
              }))}
            />
            <SelectField
              label="ساعت"
              value={hourLocal}
              onChange={setHourLocal}
              options={Array.from({ length: 24 }, (_, hour) => ({
                value: String(hour),
                label: `ساعت ${toPersianDigits(hour)}`,
              }))}
            />
            {frequency === "weekly" ? (
              <SelectField
                label="روز هفته"
                value={weekday}
                onChange={setWeekday}
                options={WEEKDAY_LABELS.map((label, index) => ({
                  value: String(index),
                  label,
                }))}
              />
            ) : null}
            {frequency === "monthly" ? (
              <SelectField
                label="روز ماه"
                value={dayOfMonth}
                onChange={setDayOfMonth}
                hint="اگر ماه کوتاه‌تر باشد، به آخرین روز ماه منتقل می‌شود."
                options={Array.from({ length: 31 }, (_, index) => ({
                  value: String(index + 1),
                  label: toPersianDigits(index + 1),
                }))}
              />
            ) : null}
            <Field label="ارسال به ایمیل" hint="خالی بگذارید تا فقط در تاریخچه ذخیره شود.">
              <input
                className={inputClass}
                type="email"
                dir="ltr"
                value={deliverEmail}
                onChange={(event) => setDeliverEmail(event.target.value)}
                placeholder="name@example.com"
              />
            </Field>
          </div>
          <PrimaryButton
            onClick={createSchedule}
            disabled={busy !== null || !scheduleName.trim() || selected.length === 0}
          >
            <CalendarClockIcon className="size-4" aria-hidden="true" />
            ساخت زمان‌بندی
          </PrimaryButton>
        </SectionCard>
      ) : null}

      <SectionCard title="زمان‌بندی‌های فعال">
        {schedules === null ? (
          <LoadingSkeleton rows={3} />
        ) : schedules.length === 0 ? (
          <EmptyState>هنوز زمان‌بندی‌ای ساخته نشده است.</EmptyState>
        ) : (
          <DataTable caption="زمان‌بندی‌های خروجی خودکار">
            <DataTableHead>
              <tr>
                <Th>نام</Th>
                <Th>نوع داده</Th>
                <Th>تناوب</Th>
                <Th>اجرای بعدی</Th>
                <Th>آخرین اجرا</Th>
                <Th>ایمیل</Th>
                <Th> </Th>
              </tr>
            </DataTableHead>
            <DataTableBody>
              {schedules.map((schedule) => (
                <DataTableRow key={schedule.id}>
                  <Td>{schedule.name}</Td>
                  <Td>{schedule.entityLabel}</Td>
                  <Td>
                    {FREQUENCY_LABELS[schedule.frequency]} — ساعت{" "}
                    {toPersianDigits(schedule.hourLocal)}
                    {schedule.frequency === "weekly" && schedule.weekday !== null
                      ? ` — ${WEEKDAY_LABELS[schedule.weekday]}`
                      : ""}
                    {schedule.frequency === "monthly" && schedule.dayOfMonth !== null
                      ? ` — روز ${toPersianDigits(schedule.dayOfMonth)}`
                      : ""}
                  </Td>
                  <Td>
                    <JalaliCell value={schedule.nextRunAt} />
                  </Td>
                  <Td>
                    {schedule.lastRunAt ? (
                      <>
                        <JalaliCell value={schedule.lastRunAt} />
                        {schedule.lastStatus === "failed" ? (
                          <span className="mt-0.5 block text-xs text-destructive">
                            {schedule.lastError ?? "ناموفق"}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>
                    {schedule.deliverEmail ? (
                      <span dir="ltr">{schedule.deliverEmail}</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      <SecondaryButton
                        onClick={() => runSchedule(schedule.id)}
                        disabled={busy !== null}
                      >
                        اجرای دستی
                      </SecondaryButton>
                      <SecondaryButton
                        onClick={() => removeSchedule(schedule.id)}
                        disabled={busy !== null}
                      >
                        <Trash2Icon className="size-4" aria-hidden="true" />
                        حذف
                      </SecondaryButton>
                    </div>
                  </Td>
                </DataTableRow>
              ))}
            </DataTableBody>
          </DataTable>
        )}
      </SectionCard>
    </div>
  );
}

function triggerDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The server's RFC 5987 filename, with a readable fallback. */
function fileNameFrom(disposition: string | null, entityLabel: string, format: string): string {
  const match = disposition ? /filename\*=UTF-8''([^;]+)/.exec(disposition) : null;
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      // A malformed header must not stop the download.
    }
  }
  return `${entityLabel}.${format === "xlsx" ? "xlsx" : format}`;
}
