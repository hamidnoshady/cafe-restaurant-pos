"use client";

/**
 * The console control for turning an app off with a reason (migration 0128).
 *
 * One component for both scopes, because they are the same control over the
 * same vocabulary and an operator should not have to learn two:
 *
 *   scope="platform" — /platform/apps, the deployment-wide state of each app.
 *   scope="business" — inside a business, an override that pins that one tenant
 *                      and a «پیروی از سکو» button that clears it again.
 *
 * The difference is one endpoint and one extra button, so it is a prop rather
 * than a second copy of the form. Dates are collected with `JalaliDatePicker`
 * (never a native date input — AGENTS.md) and sent as ISO/Gregorian, which is
 * what the column stores and the dashboard re-renders in Shamsi.
 */
import { useCallback, useEffect, useState } from "react";
import {
  APP_AVAILABILITY_META,
  APP_AVAILABILITY_STATES,
  type AppAvailabilityState,
} from "@/lib/app-availability";
import type { AppKey } from "@/lib/apps";
import { JalaliDatePicker } from "@/app/dashboard/jalali-date-picker";
import { formatJalali } from "@/lib/jalali";
import { toPersianDigits, formatPersianNumber } from "@/lib/digits";
import {
  api,
  errorMessage,
  Button,
  Card,
  ErrorBox,
  InfoBox,
  SkeletonRows,
  inputClass,
  selectClass,
  useCan,
} from "./ui";

export interface AppAvailabilityRow {
  app: AppKey;
  label: string;
  state: AppAvailabilityState;
  note: string | null;
  availableFrom: string | null;
  notice: string;
  usable: boolean;
  source: "platform" | "business";
  /** Platform scope only: how many businesses pin this app themselves. */
  overrideCount?: number;
  /** Business scope only. */
  platformState?: AppAvailabilityState;
  overridden?: boolean;
}

interface Draft {
  state: AppAvailabilityState;
  note: string;
  availableFrom: string;
}

const STATE_TONE: Record<AppAvailabilityState, string> = {
  available: "border-emerald-500/30 bg-emerald-500/15 text-emerald-300",
  beta: "border-sky-500/30 bg-sky-500/15 text-sky-300",
  coming_soon: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  maintenance: "border-amber-500/30 bg-amber-500/15 text-amber-300",
  disabled: "border-white/20 bg-white/10 text-white/60",
};

export function AppStateChip({ state }: { state: AppAvailabilityState }) {
  const meta = APP_AVAILABILITY_META[state] ?? APP_AVAILABILITY_META.available;
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATE_TONE[state]}`}
    >
      {meta.label}
    </span>
  );
}

export function AppAvailabilityEditor({
  scope,
  endpoint,
  title,
  description,
  refreshKey = 0,
}: {
  scope: "platform" | "business";
  /** The GET/PATCH endpoint for this scope. */
  endpoint: string;
  title: string;
  description?: string;
  /** Bump to re-read (the business workspace re-fetches when its context changes). */
  refreshKey?: number;
}) {
  const can = useCan();
  const editable = can("features.write");
  const [rows, setRows] = useState<AppAvailabilityRow[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const apply = useCallback((next: AppAvailabilityRow[]) => {
    setRows(next);
    setDrafts(
      Object.fromEntries(
        next.map((row) => [
          row.app,
          { state: row.state, note: row.note ?? "", availableFrom: row.availableFrom ?? "" },
        ]),
      ),
    );
  }, []);

  const load = useCallback(async () => {
    const { ok, data } = await api<{ apps: AppAvailabilityRow[]; error?: string }>(endpoint);
    if (ok) apply(data.apps);
    else setError(errorMessage(data.error));
  }, [endpoint, apply, refreshKey]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(app: AppKey, body: Record<string, unknown>) {
    setPending(app);
    setError(null);
    setSaved(null);
    const { ok, data } = await api<{ apps: AppAvailabilityRow[]; error?: string }>(endpoint, {
      method: "PATCH",
      body: JSON.stringify({ app, ...body }),
    });
    setPending(null);
    if (ok) {
      apply(data.apps);
      setSaved(app);
    } else {
      setError(errorMessage(data.error));
    }
  }

  function patchDraft(app: AppKey, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [app]: { ...current[app], ...patch },
    }));
  }

  return (
    <Card title={title}>
      {description ? <p className="mb-4 -mt-1 text-xs leading-6 text-white/45">{description}</p> : null}
      <ErrorBox>{error}</ErrorBox>
      {rows === null ? (
        <SkeletonRows rows={4} />
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const draft = drafts[row.app] ?? {
              state: row.state,
              note: row.note ?? "",
              availableFrom: row.availableFrom ?? "",
            };
            const dirty =
              draft.state !== row.state ||
              draft.note !== (row.note ?? "") ||
              draft.availableFrom !== (row.availableFrom ?? "");
            const meta = APP_AVAILABILITY_META[draft.state] ?? APP_AVAILABILITY_META.available;
            return (
              <div
                key={row.app}
                className="rounded-lg border border-white/10 bg-white/2 p-3 sm:p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{row.label}</p>
                      <AppStateChip state={row.state} />
                      {scope === "business" && row.overridden ? (
                        <span className="rounded-full border border-white/20 bg-white/10 px-2 py-0.5 text-[11px] text-white/60">
                          ویژهٔ این کسب‌وکار
                        </span>
                      ) : null}
                      {scope === "business" && !row.overridden ? (
                        <span className="text-[11px] text-white/35">
                          پیرو سکو (
                          {(APP_AVAILABILITY_META[row.platformState ?? "available"] ??
                            APP_AVAILABILITY_META.available).label}
                          )
                        </span>
                      ) : null}
                      {scope === "platform" && (row.overrideCount ?? 0) > 0 ? (
                        <span className="text-[11px] text-white/35">
                          {formatPersianNumber(row.overrideCount ?? 0)} کسب‌وکار وضعیت اختصاصی دارند
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-white/30" dir="ltr">
                      {row.app}
                    </p>
                    {row.notice ? (
                      <p className="mt-1 max-w-xl text-xs leading-6 text-white/45">
                        پیام کاربر: {row.notice}
                      </p>
                    ) : null}
                    {row.availableFrom ? (
                      <p className="mt-1 text-xs text-white/40">
                        زمان در دسترس بودن:{" "}
                        {toPersianDigits(formatJalali(row.availableFrom, { withMonthName: true }))}
                      </p>
                    ) : null}
                  </div>
                  {saved === row.app && !dirty ? (
                    <span className="text-xs text-emerald-300">ذخیره شد</span>
                  ) : null}
                </div>

                {editable ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <label className="block">
                      <span className="mb-1 block text-xs text-white/50">وضعیت</span>
                      <select
                        className={selectClass}
                        value={draft.state}
                        onChange={(e) =>
                          patchDraft(row.app, { state: e.target.value as AppAvailabilityState })
                        }
                      >
                        {APP_AVAILABILITY_STATES.map((state) => (
                          <option key={state} value={state}>
                            {APP_AVAILABILITY_META[state].label}
                          </option>
                        ))}
                      </select>
                      <span className="mt-1 block text-[11px] leading-5 text-white/35">
                        {meta.hint}
                      </span>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-white/50">
                        پیامی که کاربر می‌بیند (اختیاری)
                      </span>
                      <input
                        className={inputClass}
                        value={draft.note}
                        maxLength={500}
                        placeholder={meta.defaultNotice || "—"}
                        onChange={(e) => patchDraft(row.app, { note: e.target.value })}
                      />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs text-white/50">
                        زمان در دسترس بودن (اختیاری)
                      </span>
                      <JalaliDatePicker
                        value={draft.availableFrom}
                        onChange={(iso) => patchDraft(row.app, { availableFrom: iso })}
                        className={inputClass}
                        popoverClass="border-white/15 bg-slate-900 text-white"
                      />
                    </label>
                  </div>
                ) : null}

                {editable ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      disabled={pending === row.app || !dirty}
                      onClick={() =>
                        save(row.app, {
                          state: draft.state,
                          note: draft.note.trim() || null,
                          availableFrom: draft.availableFrom || null,
                        })
                      }
                    >
                      ذخیره
                    </Button>
                    {scope === "business" ? (
                      <Button
                        variant="ghost"
                        disabled={pending === row.app || !row.overridden}
                        onClick={() => save(row.app, { state: null })}
                      >
                        پیروی از سکو
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
      {!editable ? (
        <InfoBox>تغییر وضعیت برنامه‌ها در سطح دسترسی شما نیست؛ این فهرست فقط‌خواندنی است.</InfoBox>
      ) : null}
    </Card>
  );
}
