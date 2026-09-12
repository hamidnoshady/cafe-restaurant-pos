"use client";

/**
 * The party form — the one place a «شخص» is created or edited.
 *
 * One component, every app: the CRM opens it with the customer scope (so the role
 * arrives preset and the accounting tab is read-only), the store opens it with the
 * supplier scope, the team tab with the personnel scope, and Accounting with the
 * full scope. The *scope* changes what is shown and what is claimed for it; the
 * fields, the validation and the request body are this file's business alone. That
 * is the whole point of the rename — before it, the directory, the inventory
 * supplier tab and the ledger each had their own shorter form over their own
 * subset of the facts, and the facts disagreed.
 *
 * The state is flat (`PartyFormState`) and the request is nested
 * (`buildPartyPayload`): a form that holds its tabs in nested objects is a form
 * where «ذخیره» half-updates an address because one input wrote to the wrong level.
 * The nesting is a serialisation step at submit time, exactly once.
 *
 * Drafts are saved to `localStorage` per business and per party (`party-drafts.ts`)
 * — autosaved on a timer so a closed tab costs nothing, and never autosaved into
 * the record itself, which is the other thing a screen like this gets wrong.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCOUNTING_CODE_MODES,
  ACCOUNTING_CODE_MODE_LABELS,
  DEFAULT_TAX_PERCENTAGE,
  MAX_PARTY_DISPLAY_NAME,
  MAX_PARTY_NAME_PART,
  MAX_PARTY_NOTES,
  MAX_PROFILE_IMAGE_CHARS,
  PARTY_PERSON_TYPES,
  PARTY_PERSON_TYPE_LABELS,
  PARTY_ROLES,
  PARTY_ROLE_LABELS,
  asciiDigits,
  buildNonAccountingPayload,
  buildPartyPayload,
  formStateFromParty,
  partyFieldErrorMessage,
  hasPartyRole,
  resetPartyForm,
  togglePartyRole,
  validatePartyForm,
  withPartyRoles,
  type PartyApiRecord,
  type PartyFormState,
  type PartyRole,
} from "@/lib/parties";
import {
  deletePartyDraft,
  listPartyDrafts,
  loadPartyDraft,
  localStorageDraftStorage,
  partyDraftLabel,
  partyFormHasUnsavedChanges,
  savePartyDraft,
  type PartyDraft,
} from "@/lib/party-drafts";
import {
  canEditAccountingInScope,
  canSeeAccountingInScope,
  type PartyScopeDef,
} from "@/lib/parties-scopes";
import { toPersianDigits } from "@/lib/digits";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { LoadingSkeleton, TabBar, TabPanel } from "../page-chrome";
import { api, errorMessage, ErrorBox, Field, InfoBox, inputClass } from "../ui";

const TAB_KEYS = ["general", "address", "contact", "financial"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  general: "اطلاعات عمومی",
  address: "نشانی",
  contact: "راه‌های ارتباطی",
  financial: "اطلاعات مالی",
};

/** Which tab a field error belongs to, so the first error is the one you see. */
function tabForField(path: string): TabKey {
  if (path.startsWith("addressInfo")) return "address";
  if (path.startsWith("contactInfo")) return "contact";
  if (path.startsWith("financialInfo")) return "financial";
  return "general";
}

/** The draft autosave interval. Long enough that typing is not a write per keystroke. */
const DRAFT_AUTOSAVE_MS = 4_000;

export interface PartyFormDialogProps {
  scope: PartyScopeDef;
  /** The party being edited; absent for a new one. */
  partyId?: string | null;
  /** The record to hydrate from, when the caller already has it (the directory row). */
  initial?: PartyApiRecord | null;
  businessId: string;
  /**
   * The roles a *new* person starts with ticked — the directory's current view
   * («تأمین‌کنندگان» ticks تأمین‌کننده). Falls back to the scope's own default
   * role, which is what a single-role section always wants.
   */
  defaultRoles?: readonly PartyRole[];
  onClose: () => void;
  onSaved: (party: PartyApiRecord) => void;
}

export function PartyFormDialog({
  scope,
  partyId,
  initial,
  businessId,
  defaultRoles,
  onClose,
  onSaved,
}: PartyFormDialogProps) {
  const storage = useMemo(() => localStorageDraftStorage(), []);
  /**
   * The roles a new person opens with: the caller's (the directory's current
   * view), narrowed to what this scope may write, or the scope's default.
   */
  const openingRoles = useMemo(() => {
    const asked = (defaultRoles ?? []).filter((role) => scope.roles.includes(role));
    return asked.length > 0 ? asked : [scope.defaultRole];
  }, [defaultRoles, scope]);

  const [state, setState] = useState<PartyFormState>(() => {
    const hydrated = formStateFromParty(initial ?? null);
    // A new party starts from the app that opened the form (the store's «تأمین‌کننده
    // جدید» is not a customer with the label changed); an edit keeps its own roles.
    return partyId ? hydrated : withPartyRoles(hydrated, openingRoles);
  });
  /**
   * What the form looked like when it opened — the baseline «آیا تغییری ذخیره
   * نشده دارید؟» compares against. Kept as state and re-set on hydration so an
   * edit that loads its record from the server does not count the load itself
   * as an unsaved change.
   */
  const [baseline, setBaseline] = useState<PartyFormState>(state);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<TabKey>("general");
  const [busy, setBusy] = useState(false);
  /**
   * An edit opened by id (a deep link, a row that did not carry the record) has to
   * wait for the server's copy before it can show anything: rendering the empty
   * form for a beat and then swapping every field under the person reads as a
   * lost save.
   */
  const [loadingRecord, setLoadingRecord] = useState(Boolean(partyId && !initial));
  const [formError, setFormError] = useState("");
  const [info, setInfo] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PartyDraft[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshDrafts = useCallback(() => {
    setDrafts(listPartyDrafts(storage, businessId));
  }, [storage, businessId]);

  useEffect(refreshDrafts, [refreshDrafts]);

  // An edit of a record that already exists starts from the server's copy, not
  // from whatever the row happened to render — the row shows two columns, the
  // record holds every tab.
  useEffect(() => {
    if (!partyId || initial) return;
    let cancelled = false;
    void api<{ party: PartyApiRecord }>(`/api/parties/${encodeURIComponent(partyId)}`).then(({ ok, data }) => {
      if (cancelled) return;
      setLoadingRecord(false);
      if (!ok) {
        setFormError(errorMessage((data as { error?: string }).error));
        return;
      }
      const hydrated = formStateFromParty(data.party);
      setState(hydrated);
      setBaseline(hydrated);
    });
    return () => {
      cancelled = true;
    };
  }, [partyId, initial]);

  /**
   * Autosave. Only once the form says something — a blank new party is not a draft,
   * and a list of them would be noise (`partyFormHasUnsavedChanges` is what says
   * so, comparing the *payload* rather than the state so a form that only reset a
   * number to its default does not count as edited).
   */
  useEffect(() => {
    if (!storage) return;
    const timer = window.setInterval(() => {
      const draft = savePartyDraft(storage, {
        businessId,
        state: stateRef.current,
        draftId,
        partyId: partyId ?? null,
      });
      if (draft) setDraftId((current) => current ?? draft.id);
    }, DRAFT_AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [storage, businessId, draftId, partyId]);

  function patch(next: Partial<PartyFormState>) {
    setState((current) => ({ ...current, ...next }));
  }
  function patchTab<K extends "generalInfo" | "addressInfo" | "contactInfo" | "financialInfo">(
    key: K,
    next: Partial<PartyFormState[K]>,
  ) {
    setState((current) => ({ ...current, [key]: { ...current[key], ...next } }));
  }
  function clearError(path: string) {
    setErrors((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  const accountingEditable = canEditAccountingInScope(scope);
  const accountingVisible = canSeeAccountingInScope(scope);
  // Which roles this section may assign at all. A single-role section (the
  // store's suppliers, the team's staff) shows the one role as a fixed pill;
  // the directory shows the whole set as checkboxes, because one person really
  // can be a customer and a supplier at once.
  const assignableRoles = PARTY_ROLES.filter((role) => scope.roles.includes(role));
  const roleLocked = assignableRoles.length <= 1;

  /**
   * The unsaved-changes guard.
   *
   * Compared on the *payload*, not the state, so a form that merely re-derived
   * a default does not claim to be dirty — the same rule the draft autosave
   * uses, from the same helper, so the two can never disagree about whether
   * there is anything to lose.
   */
  const dirty = partyFormHasUnsavedChanges(state, baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const requestClose = useCallback(() => {
    if (
      dirtyRef.current &&
      !window.confirm("تغییرهای ذخیره‌نشده‌ای در این فرم دارید. بستن فرم آن‌ها را کنار می‌گذارد. ادامه می‌دهید؟")
    ) {
      return;
    }
    onClose();
  }, [onClose]);

  // The browser's own guard, for the other way out of a form: a refresh, a
  // closed tab, a link to another site. The dialog's Escape and «انصراف» go
  // through `requestClose` above.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome still requires the assignment; the string itself is never shown.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /**
   * Focus management.
   *
   * When validation sends you to another tab, the point of the jump is the
   * field that is wrong — so the first invalid control is focused, not merely
   * scrolled to. Without this a keyboard user is moved to a tab and then has
   * to hunt for the red text with the Tab key.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => {
    if (!focusField) return;
    const target = bodyRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusField)}"]`);
    target?.focus();
    setFocusField(null);
  }, [focusField, tab]);

  /** Route an error set to the tab that owns its first field, and focus it. */
  const showFirstError = useCallback((found: Record<string, string>) => {
    const first = Object.keys(found)[0] ?? "displayName";
    setErrors(found);
    setTab(tabForField(first));
    setFocusField(first);
  }, []);

  /**
   * Submit.
   *
   * Three answers, each with its own place to appear: the client's own validation
   * (the same `validatePartyForm` the route runs, so a field is red before a
   * request leaves), the route's `fieldErrors` (which can know things the browser
   * cannot — a کد ملی already held by somebody else), and any other backend error
   * (a 403 from a permission the member lacks, a 404 on a stale edit) which is
   * shown whole.
   *
   * Outside the Accounting app the ledger's numbers are shown read-only (or not
   * at all), so they are not sent back either: the route gates those keys on
   * `ledger.view`, and a round-tripped tax rate would turn a cashier's
   * phone-number fix into a 403. An omitted key means «leave it» on the server,
   * so stripping them changes nothing that is stored.
   */
  async function submit() {
    const found = validatePartyForm(state);
    if (Object.keys(found).length > 0) {
      showFirstError(found);
      return;
    }
    setErrors({});
    setBusy(true);
    setFormError("");
    const payload = accountingEditable ? buildPartyPayload(state) : buildNonAccountingPayload(state);
    const { ok, data } = partyId
      ? await api<{ party?: PartyApiRecord; error?: string; fieldErrors?: Record<string, string> }>(
          `/api/parties/${encodeURIComponent(partyId)}`,
          { method: "PUT", body: JSON.stringify(payload) },
        )
      : await api<{ party?: PartyApiRecord; error?: string; fieldErrors?: Record<string, string> }>(
          "/api/parties",
          { method: "POST", body: JSON.stringify(payload) },
        );
    setBusy(false);
    if (!ok) {
      const fieldErrors = data.fieldErrors ?? {};
      if (Object.keys(fieldErrors).length > 0) showFirstError(fieldErrors);
      setFormError(errorMessage(data.error));
      return;
    }
    // The draft was the form's shadow; the record is now real, so it goes.
    if (draftId) deletePartyDraft(storage, businessId, draftId);
    setInfo("");
    onSaved(data.party ?? { id: partyId ?? "" });
  }

  function saveDraftNow() {
    const draft = savePartyDraft(storage, { businessId, state, draftId, partyId: partyId ?? null });
    if (draft) {
      setDraftId(draft.id);
      setInfo(`پیش‌نویس «${partyDraftLabel(state)}» ذخیره شد.`);
      refreshDrafts();
    }
  }

  function restoreDraft(draft: PartyDraft) {
    setState(draft.state);
    setDraftId(draft.id);
    setErrors({});
    setShowDrafts(false);
    setInfo(`پیش‌نویس «${draft.label}» بازخوانی شد.`);
  }

  function discardDraft(id: string) {
    deletePartyDraft(storage, businessId, id);
    if (id === draftId) setDraftId(null);
    refreshDrafts();
  }

  function onProfileImagePicked(file: File | undefined) {
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      setFormError("فایل انتخابی تصویر نیست.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result ?? "");
      if (value.length > MAX_PROFILE_IMAGE_CHARS) {
        setFormError("حجم تصویر بیش از حد مجاز است (۳۰۰ کیلوبایت).");
        return;
      }
      patch({ profileImage: value });
      clearError("profileImage");
    };
    reader.readAsDataURL(file);
  }

  const has = (path: string) => errors[path];

  if (loadingRecord) {
    return (
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>در حال بارگذاری پرونده…</DialogTitle>
          </DialogHeader>
          <LoadingSkeleton rows={4} label="در حال بارگذاری پروندهٔ شخص" />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : requestClose())}>
      <DialogContent className="sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {partyId
              ? `ویرایش ${state.displayName || "شخص"}`
              : `شخص جدید — ${state.roles.map((role) => PARTY_ROLE_LABELS[role]).join(" و ")}`}
          </DialogTitle>
        </DialogHeader>

        <ErrorBox>{formError}</ErrorBox>
        {info ? <InfoBox>{info}</InfoBox> : null}


        {/* The scroller the focus lookup searches — every validated control,
            root fields and tabs alike, lives inside it. */}
        <div ref={bodyRef} className="min-w-0 space-y-4">

        {/* ---------------- root fields ---------------- */}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={state.status}
                onCheckedChange={(checked) => patch({ status: checked === true })}
                aria-label="وضعیت"
              />
              <span className={state.status ? "font-medium text-foreground" : "text-muted-foreground"}>
                {state.status ? "فعال" : "غیرفعال"}
              </span>
            </label>
            <span className="text-xs text-muted-foreground">
              شخص غیرفعال در انتخاب‌گرهای فروش و خرید نمایش داده نمی‌شود؛ سوابق او دست‌نخورده می‌ماند.
            </span>
          </div>

          {/*
            Roles, plural.

            One person can be a customer and a supplier at the same time — the
            café that buys its beans from a regular, the workshop that sells to
            the shop it buys from — and before this the only way to record that
            was two files, two accounting codes and two balances for one human
            being. So this is a checkbox group over the set, not a `<select>`
            over one value, and the first ticked role (by the product's own
            order: مشتری، تأمین‌کننده، کارکنان) is the primary one that decides
            the accounting-code prefix. A section that lists exactly one role
            still shows a fixed pill — there is nothing to choose there.
          */}
          <div className="sm:col-span-2">
            <Field label="نقش‌ها (الزامی)">
              {roleLocked ? (
                <div className="flex min-h-10 items-center">
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                    {PARTY_ROLE_LABELS[assignableRoles[0] ?? scope.defaultRole]}
                  </span>
                  <span className="ms-2 text-xs text-muted-foreground">در این بخش نقش ثابت است.</span>
                </div>
              ) : (
                <div
                  role="group"
                  aria-label="نقش‌های این شخص"
                  aria-describedby="party-form-roles-hint"
                  className="flex flex-wrap gap-2"
                >
                  {assignableRoles.map((role, index) => {
                    const checked = hasPartyRole(state, role);
                    // The last remaining role cannot be unticked: a party with
                    // no role is not a party, and refusing it here explains
                    // itself better than a 400 after «ذخیره».
                    const last = checked && state.roles.length === 1;
                    return (
                      <button
                        key={role}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        disabled={last}
                        data-field={index === 0 ? "roles" : undefined}
                        title={last ? "دست‌کم یک نقش باید انتخاب شود." : undefined}
                        onClick={() => {
                          setState((current) => togglePartyRole(current, role));
                          clearError("roles");
                          clearError("role");
                        }}
                        className={`min-h-10 rounded-xl border px-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-70 ${
                          checked
                            ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                            : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {PARTY_ROLE_LABELS[role]}
                      </button>
                    );
                  })}
                </div>
              )}
              {has("roles") ? (
                <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("roles"))}</span>
              ) : roleLocked ? null : (
                <span id="party-form-roles-hint" className="mt-1 block text-xs text-muted-foreground">
                  می‌توانید چند نقش را هم‌زمان انتخاب کنید. کد حسابداری بر پایهٔ «
                  {PARTY_ROLE_LABELS[state.role]}» ساخته می‌شود.
                </span>
              )}
            </Field>
          </div>

          <Field label="نوع شخص">
            <div className="flex gap-2">
              {PARTY_PERSON_TYPES.map((personType) => (
                <button
                  key={personType}
                  type="button"
                  onClick={() => patch({ personType })}
                  aria-pressed={state.personType === personType}
                  className={`min-h-10 flex-1 rounded-xl border px-3 text-sm font-medium transition-colors ${
                    state.personType === personType
                      ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                      : "border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {PARTY_PERSON_TYPE_LABELS[personType]}
                </button>
              ))}
            </div>
          </Field>

          <Field label="نام نمایشی (الزامی)">
            <input
              data-field="displayName"
              autoFocus
              className={inputClass}
              maxLength={MAX_PARTY_DISPLAY_NAME}
              value={state.displayName}
              onChange={(event) => {
                patch({ displayName: event.target.value });
                clearError("displayName");
              }}
              placeholder="نامی که در فهرست‌ها دیده می‌شود"
            />
            {has("displayName") ? (
              <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("displayName"))}</span>
            ) : null}
          </Field>

          <Field label="دسته‌بندی">
            <CategorySelect
              value={state.categoryId}
              role={state.role}
              onChange={(value) => patch({ categoryId: value })}
            />
          </Field>

          <Field label="نام">
            <input
              className={inputClass}
              maxLength={MAX_PARTY_NAME_PART}
              value={state.firstName}
              onChange={(event) => patch({ firstName: event.target.value })}
            />
          </Field>
          <Field label="نام خانوادگی">
            <input
              className={inputClass}
              maxLength={MAX_PARTY_NAME_PART}
              value={state.lastName}
              onChange={(event) => patch({ lastName: event.target.value })}
            />
          </Field>

          <div className="sm:col-span-2">
            <p className="mb-1 text-sm font-medium text-foreground">تصویر پروفایل</p>
            <div className="flex flex-wrap items-center gap-3">
              {state.profileImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={state.profileImage}
                  alt=""
                  className="size-12 rounded-full border border-border object-cover"
                />
              ) : null}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={(event) => onProfileImagePicked(event.target.files?.[0])}
                className="block w-full max-w-xs text-sm text-muted-foreground file:me-3 file:rounded-lg file:border-0 file:bg-muted file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-foreground"
              />
              {state.profileImage ? (
                <Button type="button" variant="ghost" size="xs" onClick={() => patch({ profileImage: "" })}>
                  برداشتن تصویر
                </Button>
              ) : null}
            </div>
            {has("profileImage") ? (
              <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("profileImage"))}</span>
            ) : null}
          </div>

          {accountingVisible ? (
            <div className="sm:col-span-2 grid min-w-0 gap-3 rounded-xl border border-border/80 bg-muted/40 p-3 sm:grid-cols-2">
              <Field label="کد حسابداری">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    className={`${inputClass} sm:max-w-32 sm:shrink-0`}
                    value={state.accountingCodeMode}
                    disabled={!accountingEditable}
                    onChange={(event) =>
                      patch({ accountingCodeMode: event.target.value as (typeof ACCOUNTING_CODE_MODES)[number] })
                    }
                  >
                    {ACCOUNTING_CODE_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {ACCOUNTING_CODE_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                  <input
                  data-field="accountingCode"
                    className={`${inputClass} sm:flex-1`}
                    dir="ltr"
                    inputMode="numeric"
                    maxLength={24}
                    disabled={!accountingEditable || state.accountingCodeMode === "Automatic"}
                    value={
                      state.accountingCodeMode === "Automatic" && !state.accountingCode
                        ? "با ذخیره ساخته می‌شود"
                        : state.accountingCode
                    }
                    onChange={(event) => {
                      patch({ accountingCode: event.target.value });
                      clearError("accountingCode");
                    }}
                  />
                </div>
                {has("accountingCode") ? (
                  <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("accountingCode"))}</span>
                ) : (
                  !accountingEditable && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      کد حسابداری در برنامهٔ حسابداری ویرایش می‌شود.
                    </span>
                  )
                )}
              </Field>
              <div className="mb-4 flex flex-col justify-end text-xs text-muted-foreground">
                <span>
                  در حالت خودکار، شماره را سامانه می‌دهد: ۱ برای مشتری، ۲ برای تأمین‌کننده، ۳ برای کارکنان.
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {/* ---------------- tabs ---------------- */}
        <TabBar
          idPrefix="party-form"
          label="بخش‌های فرم شخص"
          tabs={TAB_KEYS.map((key) => ({ key, label: TAB_LABELS[key] }))}
          active={tab}
          onChange={setTab}
          className="mt-2"
        />
        <TabPanel idPrefix="party-form" active={tab}>
          {tab === "general" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="کد ملی">
                <input
                  data-field="generalInfo.nationalId"
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={10}
                  disabled={state.personType === "Legal"}
                  value={state.generalInfo.nationalId}
                  onChange={(event) => {
                    patchTab("generalInfo", { nationalId: asciiDigits(event.target.value).slice(0, 10) });
                    clearError("generalInfo.nationalId");
                  }}
                  placeholder="۱۰ رقم"
                />
                {has("generalInfo.nationalId") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("generalInfo.nationalId"))}
                  </span>
                ) : state.personType === "Legal" ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    شخص حقوقی کد ملی ندارد؛ شمارهٔ ثبت شرکت در یادداشت‌ها ثبت شود.
                  </span>
                ) : null}
              </Field>
              <Field label="کد اقتصادی">
                <input
                  data-field="generalInfo.economicCode"
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={11}
                  value={state.generalInfo.economicCode}
                  onChange={(event) => {
                    patchTab("generalInfo", { economicCode: asciiDigits(event.target.value).slice(0, 11) });
                    clearError("generalInfo.economicCode");
                  }}
                  placeholder="۱۱ رقم"
                />
                {has("generalInfo.economicCode") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("generalInfo.economicCode"))}
                  </span>
                ) : null}
              </Field>
              <Field label="نرخ مالیات (٪)">
                <input
                  data-field="generalInfo.taxPercentage"
                  className={inputClass}
                  dir="ltr"
                  inputMode="decimal"
                  disabled={!accountingEditable}
                  value={String(state.generalInfo.taxPercentage ?? DEFAULT_TAX_PERCENTAGE)}
                  onChange={(event) => {
                    const digits = event.target.value.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
                    patchTab("generalInfo", { taxPercentage: Number(digits.replace(/[^\d.]/g, "")) });
                    clearError("generalInfo.taxPercentage");
                  }}
                />
                {has("generalInfo.taxPercentage") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("generalInfo.taxPercentage"))}
                  </span>
                ) : (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    پیش‌فرض {toPersianDigits(String(DEFAULT_TAX_PERCENTAGE))}٪ است.
                  </span>
                )}
              </Field>
              <div className="mb-4" />
              <Field label="یادداشت">
                <textarea
                  className={inputClass}
                  rows={3}
                  maxLength={MAX_PARTY_NOTES}
                  value={state.notes}
                  onChange={(event) => patch({ notes: event.target.value })}
                />
              </Field>
            </div>
          ) : null}

          {tab === "address" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="استان">
                <input
                  className={inputClass}
                  value={state.addressInfo.province}
                  onChange={(event) => patchTab("addressInfo", { province: event.target.value })}
                />
              </Field>
              <Field label="شهر">
                <input
                  className={inputClass}
                  value={state.addressInfo.city}
                  onChange={(event) => patchTab("addressInfo", { city: event.target.value })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="نشانی پستی">
                  <textarea
                    className={inputClass}
                    rows={2}
                    value={state.addressInfo.street}
                    onChange={(event) => patchTab("addressInfo", { street: event.target.value })}
                  />
                </Field>
              </div>
              <Field label="کد پستی">
                <input
                  data-field="addressInfo.zipCode"
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  maxLength={10}
                  value={state.addressInfo.zipCode}
                  onChange={(event) => {
                    patchTab("addressInfo", { zipCode: asciiDigits(event.target.value).slice(0, 10) });
                    clearError("addressInfo.zipCode");
                  }}
                />
                {has("addressInfo.zipCode") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("addressInfo.zipCode"))}
                  </span>
                ) : null}
              </Field>
              <Field label="صندوق پستی">
                <input
                  className={inputClass}
                  dir="ltr"
                  maxLength={20}
                  value={state.addressInfo.postalBox}
                  onChange={(event) => patchTab("addressInfo", { postalBox: event.target.value })}
                />
              </Field>
            </div>
          ) : null}

          {tab === "contact" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="تلفن همراه">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="tel"
                  maxLength={32}
                  value={state.contactInfo.mobile}
                  onChange={(event) => patchTab("contactInfo", { mobile: event.target.value })}
                  placeholder="0912…"
                />
              </Field>
              <Field label="تلفن ثابت">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="tel"
                  maxLength={32}
                  value={state.contactInfo.phone}
                  onChange={(event) => patchTab("contactInfo", { phone: event.target.value })}
                />
              </Field>
              <Field label="پست الکترونیکی">
                <input
                  data-field="contactInfo.email"
                  className={inputClass}
                  dir="ltr"
                  type="email"
                  maxLength={200}
                  value={state.contactInfo.email}
                  onChange={(event) => {
                    patchTab("contactInfo", { email: event.target.value });
                    clearError("contactInfo.email");
                  }}
                />
                {has("contactInfo.email") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("contactInfo.email"))}
                  </span>
                ) : null}
              </Field>
              <Field label="وب‌سایت">
                <input
                  data-field="contactInfo.website"
                  className={inputClass}
                  dir="ltr"
                  maxLength={200}
                  value={state.contactInfo.website}
                  onChange={(event) => {
                    patchTab("contactInfo", { website: event.target.value });
                    clearError("contactInfo.website");
                  }}
                  placeholder="https://"
                />
                {has("contactInfo.website") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("contactInfo.website"))}
                  </span>
                ) : null}
              </Field>
            </div>
          ) : null}

          {tab === "financial" ? (
            accountingVisible ? (
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <Field label="نام بانک">
                  <input
                    className={inputClass}
                    disabled={!accountingEditable}
                    value={state.financialInfo.bankName}
                    onChange={(event) => patchTab("financialInfo", { bankName: event.target.value })}
                  />
                </Field>
                <Field label="شماره حساب">
                  <input
                    className={inputClass}
                    dir="ltr"
                    disabled={!accountingEditable}
                    maxLength={40}
                    value={state.financialInfo.accountNumber}
                    onChange={(event) => patchTab("financialInfo", { accountNumber: event.target.value })}
                  />
                </Field>
                <Field label="شماره کارت">
                  <input
                  data-field="financialInfo.cardNumber"
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    disabled={!accountingEditable}
                    maxLength={19}
                    value={state.financialInfo.cardNumber}
                    onChange={(event) => {
                      patchTab("financialInfo", { cardNumber: asciiDigits(event.target.value).slice(0, 16) });
                      clearError("financialInfo.cardNumber");
                    }}
                  />
                  {has("financialInfo.cardNumber") ? (
                    <span className="mt-1 block text-xs text-destructive">
                      {partyFieldErrorMessage(has("financialInfo.cardNumber"))}
                    </span>
                  ) : null}
                </Field>
                <Field label="شبا (IBAN)">
                  <input
                  data-field="financialInfo.iban"
                    className={inputClass}
                    dir="ltr"
                    disabled={!accountingEditable}
                    maxLength={26}
                    value={state.financialInfo.iban}
                    onChange={(event) => {
                      patchTab("financialInfo", { iban: event.target.value.toUpperCase().replace(/\s/g, "") });
                      clearError("financialInfo.iban");
                    }}
                    placeholder="IR…"
                  />
                  {has("financialInfo.iban") ? (
                    <span className="mt-1 block text-xs text-destructive">
                      {partyFieldErrorMessage(has("financialInfo.iban"))}
                    </span>
                  ) : null}
                </Field>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">این بخش در این برنامه نمایش داده نمی‌شود.</p>
            )
          ) : null}
        </TabPanel>
        </div>

        {/* ---------------- drafts ---------------- */}
        <div className="rounded-xl border border-border/80 bg-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" variant="outline" size="xs" onClick={saveDraftNow} disabled={busy}>
              ذخیرهٔ پیش‌نویس
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setShowDrafts((show) => !show)}
              disabled={drafts.length === 0 && !showDrafts}
            >
              پیش‌نویس‌ها ({toPersianDigits(String(drafts.length))})
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                // resetForm(): back to the defaults the section started with — not to
                // blank, which would lose the tax rate and the scope's role too.
                setState({ ...resetPartyForm(), role: scope.defaultRole });
                setDraftId(null);
                setErrors({});
                setInfo("فرم به مقادیر اولیه بازگشت.");
              }}
            >
              پاک کردن فرم
            </Button>
            {draftId ? <span className="text-xs text-muted-foreground">پیش‌نویس این فرم خودکار ذخیره می‌شود.</span> : null}
          </div>
          {showDrafts ? (
            <ul className="mt-2 divide-y divide-border/80">
              {drafts.map((draft) => (
                <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{draft.label}</span>
                    <span className="ms-2 text-xs text-muted-foreground">{toPersianDigits(draft.savedAt.slice(0, 16)).replace("T", " ")}</span>
                  </span>
                  <span className="flex gap-1">
                    <Button type="button" variant="ghost" size="xs" onClick={() => restoreDraft(draft)}>
                      بازخوانی
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => discardDraft(draft.id)}
                    >
                      حذف
                    </Button>
                  </span>
                </li>
              ))}
              {drafts.length === 0 ? <li className="py-2 text-sm text-muted-foreground">پیش‌نویسی ذخیره نشده است.</li> : null}
            </ul>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The category picker, with its own inline «دستهٔ جدید».
 *
 * Categories are data, not settings: the person who needs the group is the person
 * filling this form, and making them leave to a settings tab and come back is how
 * a grouping ends up half-used.
 */
function CategorySelect({
  value,
  role,
  onChange,
}: {
  value: string;
  role: PartyRole;
  onChange: (value: string) => void;
}) {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void api<{ categories: { id: string; name: string }[] }>(
      `/api/parties/categories?role=${encodeURIComponent(role)}`,
    ).then(({ ok, data }) => {
      if (ok) setCategories(data.categories ?? []);
    });
  }, [role]);
  useEffect(load, [load]);

  async function addCategory() {
    const name = newName.trim();
    if (!name) return;
    setError("");
    const { ok, data } = await api<{ category?: { id: string; name: string }; error?: string }>(
      "/api/parties/categories",
      { method: "POST", body: JSON.stringify({ name, role }) },
    );
    if (!ok) {
      setError(errorMessage((data as { error?: string }).error));
      return;
    }
    setNewName("");
    setAdding(false);
    load();
    if (data.category) onChange(data.category.id);
  }

  if (!adding) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          className={`${inputClass} sm:flex-1`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">بدون دسته</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setAdding(true)}>
          + دسته
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={`${inputClass} sm:flex-1`}
          maxLength={80}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="نام دستهٔ جدید"
        />
        <div className="flex gap-2">
          <Button type="button" size="sm" className="flex-1 sm:flex-none" onClick={addCategory} disabled={!newName.trim()}>
            افزودن
          </Button>
          <Button type="button" variant="ghost" size="sm" className="flex-1 sm:flex-none" onClick={() => setAdding(false)}>
            انصراف
          </Button>
        </div>
      </div>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
