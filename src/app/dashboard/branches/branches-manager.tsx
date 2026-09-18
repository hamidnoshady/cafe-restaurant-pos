"use client";

/**
 * Phase 14 — «مدیریت شعب»: the business's branches, and the form that adds one.
 *
 * Three rules this screen is built around:
 *
 *  - **Editing is a form, not a `prompt()`.** Renaming used to call the
 *    browser's native `prompt`, which cannot be styled, is RTL-hostile, is
 *    blocked outright in the Electron shell and in an embedded webview, and
 *    could only ever edit the *name* — so address, phone and the branch's
 *    timezone had no edit path at all once the branch existed. It is a dialog
 *    with the same fields as the add form now.
 *
 *  - **Nothing is guessed about why an action will fail.** The list carries
 *    each branch's open orders, open table sessions and member count, so the
 *    reason «غیرفعال‌سازی» is unavailable is on screen *before* the click, and
 *    the plan's branch ceiling is shown next to the add form rather than
 *    discovered by submitting it.
 *
 *  - **Deactivation is confirmed and reversible.** It is the one destructive
 *    action here (members lose access to the branch the moment it lands), so
 *    it asks first and says what will happen; reactivation does not, because
 *    it takes nothing away.
 */

import { EmptyState, LoadingSkeleton, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PencilIcon, PowerIcon, PowerOffIcon } from "lucide-react";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import {
  COMMON_BRANCH_TIMEZONES,
  DEFAULT_BRANCH_TIMEZONE,
  MAX_BRANCH_ADDRESS,
  MAX_BRANCH_NAME,
  MAX_BRANCH_PHONE,
} from "@/lib/branch-input";
import { BRANCH_COLORS, branchColorStyle } from "@/lib/branch-color";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { radioMoveForKey, radioTargetIndex } from "@/lib/radio-keys";

interface Branch {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  color: string;
  isActive: boolean;
  createdAt: string;
  openOrderCount: number;
  openSessionCount: number;
  memberCount: number;
}

interface PlanUsage {
  key: string;
  name: string;
  /** null = unlimited */
  branchLimit: number | null;
  activeBranchCount: number;
}

interface BranchesResponse {
  branches: Branch[];
  plan: PlanUsage;
}

/** The fields both the add form and the edit dialog collect. */
interface BranchDraft {
  name: string;
  address: string;
  phone: string;
  timezone: string;
  /**
   * Palette key, or "" meaning "let the server pick one no other branch is
   * using" — so an owner who ignores this field still gets branches they can
   * tell apart in the switcher.
   */
  color: string;
}

const EMPTY_DRAFT: BranchDraft = {
  name: "",
  address: "",
  phone: "",
  timezone: DEFAULT_BRANCH_TIMEZONE,
  color: "",
};

/**
 * The messages that are *specific to this screen*. Everything shared
 * (`branch_name_taken`, `last_active_branch`, `invalid_timezone`, the plan
 * ceiling…) lives in `ui.tsx`'s dictionary, which `errorMessage` reads — this
 * only overrides the couple of codes whose generic wording would be vaguer
 * here than the screen can afford.
 */
const BRANCH_ERROR_LABELS: Record<string, string> = {
  name_too_long: `نام شعبه نباید بیش از ${toPersianDigits(MAX_BRANCH_NAME)} نویسه باشد.`,
  invalid_color: "رنگ انتخاب‌شده معتبر نیست.",
  address_too_long: `آدرس نباید بیش از ${toPersianDigits(MAX_BRANCH_ADDRESS)} نویسه باشد.`,
  phone_too_long: `شمارهٔ تلفن نباید بیش از ${toPersianDigits(MAX_BRANCH_PHONE)} نویسه باشد.`,
  missing_fields: "نام شعبه الزامی است.",
};

function branchErrorMessage(code: string | undefined): string {
  return code ? (BRANCH_ERROR_LABELS[code] ?? errorMessage(code)) : errorMessage(code);
}

/** «Asia/Tehran» reads better to an Iranian owner as «تهران (Asia/Tehran)». */
const TIMEZONE_LABELS: Record<string, string> = {
  "Asia/Tehran": "تهران",
  "Asia/Dubai": "دبی",
  "Asia/Baghdad": "بغداد",
  "Asia/Qatar": "دوحه",
  "Asia/Kuwait": "کویت",
  "Asia/Istanbul": "استانبول",
  "Asia/Yerevan": "ایروان",
  "Asia/Baku": "باکو",
  "Asia/Kabul": "کابل",
  "Europe/Istanbul": "استانبول",
  "Europe/Berlin": "برلین",
  "Europe/London": "لندن",
  UTC: "زمان جهانی",
};

function timezoneLabel(zone: string): string {
  const name = TIMEZONE_LABELS[zone];
  return name ? `${name} (${zone})` : zone;
}

/**
 * The picker's options, with the branch's current zone folded in even when it
 * is not one of the curated ones — a branch already on an unusual zone must
 * not have it silently rewritten to Tehran just by opening the edit dialog.
 */
function timezoneOptions(current: string): { value: string; label: string }[] {
  const zones = COMMON_BRANCH_TIMEZONES.includes(current)
    ? COMMON_BRANCH_TIMEZONES
    : [current, ...COMMON_BRANCH_TIMEZONES];
  return zones.map((zone) => ({ value: zone, label: timezoneLabel(zone) }));
}

/** Why this branch cannot be deactivated right now, or null when it can be. */
function deactivationBlocker(branch: Branch, activeCount: number): string | null {
  if (activeCount <= 1) return "این تنها شعبهٔ فعال کسب‌وکار است.";
  if (branch.openOrderCount > 0)
    return `${toPersianDigits(branch.openOrderCount)} سفارش باز دارد.`;
  if (branch.openSessionCount > 0)
    return `${toPersianDigits(branch.openSessionCount)} میز باز دارد.`;
  return null;
}

export function BranchesManager() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [plan, setPlan] = useState<PlanUsage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const [draft, setDraft] = useState<BranchDraft>(EMPTY_DRAFT);
  const [copyFrom, setCopyFrom] = useState("");
  const [busy, setBusy] = useState(false);
  /** The id of the branch whose row action is in flight, so only it spins. */
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Branch | null>(null);
  const [confirmingDeactivation, setConfirmingDeactivation] = useState<Branch | null>(null);

  const load = useCallback(async () => {
    // fetch itself can reject (offline, server restart); without the catch the
    // screen stayed on «در حال بارگذاری شعب» forever with no way to retry.
    try {
      const res = await api<BranchesResponse & { error?: string }>("/api/branches");
      if (res.ok) {
        setBranches(res.data.branches);
        setPlan(res.data.plan ?? null);
        // A reload that succeeds clears whatever failed last time; leaving a
        // stale red box above a correct list is its own small lie.
        setError("");
      } else {
        setError(branchErrorMessage(res.data.error));
      }
    } catch {
      setError("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activeBranches = useMemo(() => branches.filter((b) => b.isActive), [branches]);
  const atBranchLimit =
    plan?.branchLimit != null && plan.activeBranchCount >= plan.branchLimit;

  async function createBranch() {
    if (busy || !draft.name.trim()) return;
    setBusy(true);
    setError("");
    let res: { ok: boolean; data: { error?: string } };
    try {
      res = await api<{ error?: string }>("/api/branches", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          address: draft.address || undefined,
          phone: draft.phone || undefined,
          timezone: draft.timezone || undefined,
          color: draft.color || undefined,
          copyMenuFromLocationId: copyFrom || undefined,
        }),
      });
    } catch {
      setBusy(false);
      setError("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
      return;
    }
    setBusy(false);
    if (!res.ok) {
      setError(branchErrorMessage(res.data.error));
      return;
    }
    // Only cleared on success: a rejected submission that wiped the form made
    // the owner retype everything to fix one field.
    setDraft(EMPTY_DRAFT);
    setCopyFrom("");
    toast.success("شعبهٔ جدید ساخته شد.");
    await load();
  }

  async function setActive(branch: Branch, isActive: boolean) {
    if (rowBusyId) return;
    setRowBusyId(branch.id);
    setError("");
    let res: { ok: boolean; data: { error?: string } };
    try {
      res = await api<{ error?: string }>(`/api/branches/${branch.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      });
    } catch {
      setRowBusyId(null);
      setError("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
      return;
    }
    setRowBusyId(null);
    if (!res.ok) {
      setError(branchErrorMessage(res.data.error));
      return;
    }
    toast.success(isActive ? `«${branch.name}» فعال شد.` : `«${branch.name}» غیرفعال شد.`);
    await load();
  }

  if (loading) return <LoadingSkeleton rows={3} label="در حال بارگذاری شعب" />;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title="شعب"
        description={
          plan
            ? plan.branchLimit === null
              ? `پلن ${plan.name} — بدون محدودیت در تعداد شعبه.`
              : `پلن ${plan.name} — ${toPersianDigits(plan.activeBranchCount)} شعبهٔ فعال از ${toPersianDigits(plan.branchLimit)}.`
            : undefined
        }
        flush
      >
        {branches.length === 0 ? (
          <div className="p-4 sm:p-5">
            <EmptyState>هنوز شعبه‌ای ثبت نشده است. با فرم پایین اولین شعبه را بسازید.</EmptyState>
          </div>
        ) : (
          <ul className="space-y-2 p-4 sm:p-5">
            {branches.map((branch) => {
              const blocker = deactivationBlocker(branch, activeBranches.length);
              const rowBusy = rowBusyId === branch.id;
              return (
                <li
                  key={branch.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-muted/60 px-4 py-3"
                >
                  {/* The same colour the switcher paints, so the list and the
                      header agree and the branch is recognisable in both. */}
                  <span
                    className={cn("h-10 w-1.5 shrink-0 rounded-full", branchColorStyle(branch.color).dot)}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                      {branch.name}
                      <StatusBadge tone={branch.isActive ? "positive" : "neutral"}>
                        {branch.isActive ? "فعال" : "غیرفعال"}
                      </StatusBadge>
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {[branch.address, branch.phone ? formatPhoneDisplay(branch.phone) : null]
                        .filter(Boolean)
                        .join(" · ") || "بدون آدرس/تلفن ثبت‌شده"}
                      {" · ایجاد "}
                      {toPersianDigits(formatJalali(new Date(branch.createdAt)))}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{timezoneLabel(branch.timezone)}</span>
                      <span>{toPersianDigits(branch.memberCount)} کاربر</span>
                      {branch.openOrderCount > 0 ? (
                        <span className="text-amber-700 dark:text-amber-300">
                          {toPersianDigits(branch.openOrderCount)} سفارش باز
                        </span>
                      ) : null}
                      {branch.openSessionCount > 0 ? (
                        <span className="text-amber-700 dark:text-amber-300">
                          {toPersianDigits(branch.openSessionCount)} میز باز
                        </span>
                      ) : null}
                    </p>
                    {branch.isActive && blocker ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        غیرفعال‌سازی ممکن نیست: {blocker}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="px-4"
                      disabled={rowBusy}
                      onClick={() => setEditing(branch)}
                    >
                      <PencilIcon aria-hidden="true" />
                      ویرایش
                    </Button>
                    {branch.isActive ? (
                      <Button
                        type="button"
                        variant="outline"
                        className="px-4"
                        disabled={rowBusy || Boolean(blocker)}
                        title={blocker ?? undefined}
                        onClick={() => setConfirmingDeactivation(branch)}
                      >
                        <PowerOffIcon aria-hidden="true" />
                        {rowBusy ? "در حال انجام…" : "غیرفعال‌سازی"}
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="px-4"
                        disabled={rowBusy || atBranchLimit}
                        title={atBranchLimit ? "به سقف شعبه‌های پلن رسیده‌اید." : undefined}
                        onClick={() => void setActive(branch, true)}
                      >
                        <PowerIcon aria-hidden="true" />
                        {rowBusy ? "در حال انجام…" : "فعال‌سازی"}
                      </Button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="افزودن شعبهٔ جدید"
        description="شعبهٔ جدید با همان سرفصل حساب‌ها و تنظیمات مالی کسب‌وکار کار می‌کند."
      >
        {atBranchLimit ? (
          <InfoBox>
            به سقف تعداد شعبهٔ پلن فعلی رسیده‌اید. برای افزودن شعبهٔ بیشتر، پلن را ارتقا دهید یا یکی از
            شعب فعال را غیرفعال کنید.
          </InfoBox>
        ) : null}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void createBranch();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <BranchFields
              draft={draft}
              onChange={setDraft}
              disabled={busy || atBranchLimit}
              allowAutoColor
            />
            <Field label="کپی منو از شعبهٔ دیگر (اختیاری)">
              <SearchableSelect
                value={copyFrom}
                onChange={setCopyFrom}
                disabled={busy || atBranchLimit || activeBranches.length === 0}
                ariaLabel="کپی منو از شعبهٔ دیگر"
                options={[
                  { value: "", label: "بدون کپی — منوی خالی" },
                  ...activeBranches.map((branch) => ({ value: branch.id, label: branch.name })),
                ]}
              />
            </Field>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            کپی فقط ساختار منو (دسته‌ها، آیتم‌ها و افزودنی‌ها) را شامل می‌شود؛ موجودی انبار، دستور پخت و
            چاپگرها منتقل نمی‌شوند، چون به‌صورت فیزیکی مختص هر شعبه‌اند. سرفصل حساب‌ها در کل کسب‌وکار
            مشترک است و نیازی به کپی ندارد.
          </p>
          <div className="mt-3">
            <PrimaryButton disabled={busy || atBranchLimit || !draft.name.trim()}>
              {busy ? "در حال ایجاد…" : "ایجاد شعبه"}
            </PrimaryButton>
          </div>
        </form>
      </SectionCard>

      {editing ? (
        <EditBranchDialog
          branch={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toast.success("تغییرات شعبه ذخیره شد.");
            await load();
          }}
        />
      ) : null}

      {confirmingDeactivation ? (
        <ConfirmDeactivationDialog
          branch={confirmingDeactivation}
          busy={rowBusyId === confirmingDeactivation.id}
          onClose={() => setConfirmingDeactivation(null)}
          onConfirm={async () => {
            const branch = confirmingDeactivation;
            setConfirmingDeactivation(null);
            await setActive(branch, false);
          }}
        />
      ) : null}
    </div>
  );
}

/** Name, address, phone and timezone — shared by the add form and the edit dialog. */
function BranchFields({
  draft,
  onChange,
  disabled,
  allowAutoColor,
}: {
  draft: BranchDraft;
  onChange: (next: BranchDraft) => void;
  disabled?: boolean;
  allowAutoColor?: boolean;
}) {
  return (
    <>
      <Field label="نام شعبه">
        <input
          className={inputClass}
          value={draft.name}
          maxLength={MAX_BRANCH_NAME}
          disabled={disabled}
          required
          onChange={(e) => onChange({ ...draft, name: e.target.value })}
        />
      </Field>
      <Field label="آدرس (اختیاری)">
        <input
          className={inputClass}
          value={draft.address}
          maxLength={MAX_BRANCH_ADDRESS}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, address: e.target.value })}
        />
      </Field>
      <Field label="تلفن (اختیاری)">
        {/* A plain tel input, not PersianNumberInput: a phone number is an
            identifier, not a numeric value — the numeric control strips every
            character that is not a digit, so a branch's `+98…` line lost its
            plus sign (and any spaces or dashes) on the way into the field,
            silently. The API accepts free text up to MAX_BRANCH_PHONE and
            formatPhoneDisplay renders whatever shape arrives. */}
        <input
          className={inputClass}
          dir="ltr"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          maxLength={MAX_BRANCH_PHONE}
          value={draft.phone}
          disabled={disabled}
          // Persian digits become ASCII on the way into state (the storage
          // convention — digits are display-only Persian); +, spaces and
          // dashes survive for formatPhoneDisplay to normalise on render.
          onChange={(e) => onChange({ ...draft, phone: toLatinDigits(e.target.value) })}
          placeholder="021…"
        />
      </Field>
      <Field
        label="منطقهٔ زمانی"
        hint="روز کاری، گزارش‌ها و ساعت رسیدهای این شعبه بر اساس این منطقه محاسبه می‌شود."
      >
        <SearchableSelect
          value={draft.timezone}
          onChange={(timezone) => onChange({ ...draft, timezone })}
          disabled={disabled}
          ariaLabel="منطقهٔ زمانی شعبه"
          options={timezoneOptions(draft.timezone)}
        />
      </Field>
      <div className="sm:col-span-2">
        {/* `as="div"`, not a label: a <label> forwards a click on its text to
            its first labelable descendant, so a tap on the two-line hint under
            the swatches (an easy thing to hit on a phone) pressed the first
            colour and silently repainted the branch. The radiogroup names
            itself below. */}
        <Field
          label="رنگ شعبه"
          hint="این رنگ در کلید تعویض شعبه دیده می‌شود تا در یک نگاه بدانید در کدام شعبه کار می‌کنید. رنگ اصلی برنامه تغییر نمی‌کند."
          as="div"
        >
          <BranchColorPicker
            value={draft.color}
            onChange={(color) => onChange({ ...draft, color })}
            disabled={disabled}
            allowAuto={allowAutoColor}
          />
        </Field>
      </div>
    </>
  );
}

/**
 * The branch colour choice.
 *
 * Swatches rather than a select or a native colour input:
 *
 *  - The value is a palette key, not a colour (see branch-color.ts) — a
 *    `<input type="color">` would offer sixteen million values the column's
 *    CHECK rejects, and hand back hexes that are unreadable in one theme.
 *  - The thing being chosen *is* its own appearance, so showing the options is
 *    strictly better than naming them in a list.
 *
 * A radiogroup, not buttons: it is a single choice among a small set, and
 * arrow keys should move through it. Each swatch keeps its Persian colour name
 * as its accessible name, so the control is usable without seeing the colours.
 */
function BranchColorPicker({
  value,
  onChange,
  disabled,
  allowAuto,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Offers «خودکار» — only meaningful when adding, where "" means let the server choose. */
  allowAuto?: boolean;
}) {
  // «خودکار» occupies slot 0 when it is offered, so the swatches' indices
  // shift by one — the value at an index is what the arrows move over.
  const values = useMemo(
    () => (allowAuto ? ["", ...BRANCH_COLORS] : [...BRANCH_COLORS]),
    [allowAuto],
  );
  // Roving focus: the checked option is the one Tab stop; arrows move and
  // check (radio-keys.ts). Every swatch keeps its Persian colour name as its
  // accessible name, so the control is usable without seeing the colours.
  const buttonsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // When nothing matches (a value the palette no longer knows), the first
  // option stands in as the Tab stop so the group is never unreachable by
  // keyboard.
  const anySelected = values.includes(value);

  return (
    <div role="radiogroup" aria-label="رنگ شعبه" className="flex flex-wrap items-center gap-2">
      {values.map((color, index) => {
        const isAuto = color === "";
        const style = branchColorStyle(color);
        const selected = value === color;
        return (
          <button
            key={color}
            ref={(node) => {
              buttonsRef.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={
              isAuto ? "خودکار — انتخاب رنگی که شعبهٔ دیگری ندارد" : style.label
            }
            title={isAuto ? undefined : style.label}
            disabled={disabled}
            tabIndex={selected || (!anySelected && index === 0) ? 0 : -1}
            onClick={() => onChange(color)}
            onKeyDown={(event) => {
              const move = radioMoveForKey(event.key, true);
              const target = move && radioTargetIndex(move, index, values.length);
              if (target === null) return;
              event.preventDefault();
              onChange(values[target]);
              buttonsRef.current[target]?.focus();
            }}
            className={cn(
              isAuto
                ? "min-h-11 rounded-xl border px-3 text-xs font-medium transition-colors"
                : "flex size-11 items-center justify-center rounded-xl border transition-transform",
              isAuto && "border-border bg-muted text-muted-foreground hover:bg-muted/70",
              !isAuto && style.surface,
              !isAuto && !disabled && "hover:scale-105",
              selected && "ring-2 ring-offset-1",
              selected && (isAuto ? "ring-primary" : style.ring),
              disabled && "pointer-events-none opacity-50",
            )}
          >
            {isAuto ? (
              "خودکار"
            ) : (
              <span className={cn("size-4 rounded-full", style.dot)} aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Editing an existing branch.
 *
 * Sends only the fields that actually changed, so the audit entry records the
 * edit rather than a restatement of every field, and an unchanged form is
 * refused by the API's `nothing_to_change` instead of writing a no-op.
 */
function EditBranchDialog({
  branch,
  onClose,
  onSaved,
}: {
  branch: Branch;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [draft, setDraft] = useState<BranchDraft>({
    name: branch.name,
    address: branch.address ?? "",
    phone: branch.phone ?? "",
    timezone: branch.timezone,
    color: branch.color,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const changes = useMemo(() => {
    const body: Record<string, string | null> = {};
    // Compare and send the trimmed name: sending the raw draft made « شعبه »
    // count as a change against «شعبه» and put the untrimmed string in the
    // request (the server normalises again, but the audit diff and the
    // duplicate check should see what will actually be stored).
    const name = draft.name.trim();
    if (name && name !== branch.name) body.name = name;
    if ((draft.address.trim() || null) !== branch.address) body.address = draft.address.trim() || null;
    if ((draft.phone.trim() || null) !== branch.phone) body.phone = draft.phone.trim() || null;
    if (draft.timezone !== branch.timezone) body.timezone = draft.timezone;
    if (draft.color !== branch.color) body.color = draft.color;
    return body;
  }, [branch, draft]);

  const dirty = Object.keys(changes).length > 0;

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError("");
    try {
      const res = await api<{ error?: string }>(`/api/branches/${branch.id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        setError(branchErrorMessage(res.data.error));
        return;
      }
      await onSaved();
    } catch {
      setError("ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی و دوباره تلاش کنید.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>ویرایش شعبه</DialogTitle>
          <DialogDescription>
            نام، آدرس، تلفن و منطقهٔ زمانی این شعبه. تغییر منطقهٔ زمانی، روز کاری و بازهٔ گزارش‌های
            این شعبه را جابه‌جا می‌کند.
          </DialogDescription>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <form
          id="edit-branch-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {/* Same two-column grid as the add form, so the two ways of editing
              a branch present identically. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <BranchFields draft={draft} onChange={setDraft} disabled={busy} />
          </div>
        </form>
        <DialogFooter>
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <Button type="submit" form="edit-branch-form" disabled={busy || !dirty}>
            {busy ? "در حال ذخیره…" : "ذخیرهٔ تغییرات"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Deactivation asks first.
 *
 * It takes a branch away from everyone assigned to it in the same instant —
 * the switcher drops it, the till can't be opened there — so the number of
 * members affected is spelled out, along with the fact that nothing is
 * deleted and the branch can be turned back on.
 */
function ConfirmDeactivationDialog({
  branch,
  busy,
  onClose,
  onConfirm,
}: {
  branch: Branch;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>غیرفعال‌سازی «{branch.name}»؟</DialogTitle>
          <DialogDescription>
            {branch.memberCount > 0
              ? `${toPersianDigits(branch.memberCount)} کاربر دیگر نمی‌توانند در این شعبه کار کنند.`
              : "این شعبه دیگر برای ثبت سفارش در دسترس نخواهد بود."}{" "}
            هیچ اطلاعاتی حذف نمی‌شود؛ سوابق و گزارش‌های گذشته دست‌نخورده می‌مانند و هر زمان می‌توانید
            دوباره آن را فعال کنید.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <SecondaryButton onClick={onClose} disabled={busy}>
            انصراف
          </SecondaryButton>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void onConfirm()}>
            {busy ? "در حال انجام…" : "غیرفعال کن"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
