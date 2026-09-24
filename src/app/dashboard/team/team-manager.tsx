"use client";

/**
 * Phase 13 — the team screen. Three cards plus the personnel files:
 *  1. Members — name, role, branches, login phone, status; the full editor
 *     (role, per-permission overrides, branches, default branch), credential
 *     resets, suspend, remove.
 *  2. Invitations — invite by email, show the link exactly once, revoke.
 *  3. Add staff — PIN-based cashier/waiter/kitchen, who have no email.
 *
 * The member row's actions map one-to-one onto what the API actually accepts
 * (`PATCH /api/team/:id` carries `fullName`, `role`, `permissions`,
 * `locationIds`, `defaultLocationId`, `phone`; `PUT …/credentials` carries
 * `pin`/`password`) — before, the API offered all of it and the screen showed
 * a role-and-toggles editor and nothing else, so a member's name or branches
 * could only be fixed by removing and re-adding the person.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { roleBasePermissions } from "@/lib/permissions";
import {
  AccessChangeSummary,
  PermissionEditor,
} from "@/components/team/permission-editor";
import { isLocationScope, type LocationScope } from "@/lib/location-access";
import { PIN_MAX_LENGTH, PIN_MIN_LENGTH, isValidPin } from "@/lib/pin-policy";
import { roleLabel } from "@/lib/role-labels";
import { toLatinDigits, toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { formatPhoneDisplay } from "@/lib/phone";
import { partyScopeFor } from "@/lib/parties-scopes";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { LoadingSkeleton, SectionCard } from "../page-chrome";
import { PartiesSection } from "../parties/parties-section";
import {
  ErrorBox,
  Field,
  InfoBox,
  PrimaryButton,
  SecondaryButton,
  api,
  errorMessage,
  inputClass,
} from "../ui";

/** Roles that sign in with an email and password, so can be invited. */
const INVITABLE_ROLES = ["manager", "accountant", "owner"] as const;
/** Roles that sign in with a PIN on a shared device, so are created directly. */
const PIN_ROLES = ["cashier", "waiter", "kitchen"] as const;


/** How a member's branch reach reads in the list. One sentence, from the policy. */
function branchSummary(member: Member, locationName: Map<string, string>): string {
  switch (member.locationScope) {
    case "all":
      return "همهٔ شعبه‌ها";
    case "home":
      return member.defaultLocationId
        ? `فقط ${locationName.get(member.defaultLocationId) ?? "شعبهٔ اصلی"}`
        : "بدون شعبه";
    case "selected":
      return member.locationIds.length > 0
        ? `شعبه‌ها: ${member.locationIds.map((id) => locationName.get(id) ?? "—").join("، ")}`
        : "بدون شعبه";
  }
}

interface Member {
  id: string;
  role: string;
  fullName: string;
  email: string | null;
  isActive: boolean;
  hasPin: boolean;
  hasLogin: boolean;
  /** Phase 42 — the login phone (E.164) and whether the member has proven it with an OTP. */
  phone: string | null;
  phoneVerified: boolean;
  locationIds: string[];
  /** The explicit branch policy (migration 0170); see LocationScope. */
  locationScope: LocationScope;
  defaultLocationId: string | null;
  overrides: { granted?: string[]; revoked?: string[] };
  effectivePermissions: string[];
  createdAt: string;
}

/** A branch as `/api/team` hands it to the screen — enough to assign people to. */
interface TeamLocation {
  id: string;
  name: string;
  isActive: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  fullName: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expiresAt: string;
  createdAt: string;
}

const INVITATION_STATUS_LABELS: Record<Invitation["status"], string> = {
  pending: "در انتظار",
  accepted: "پذیرفته‌شده",
  revoked: "لغوشده",
  expired: "منقضی",
};

/** Which role options the editor offers — every assignable role, labelled once. */
const ROLE_OPTIONS = (["owner", "manager", "accountant", "cashier", "waiter", "kitchen"] as const).map(
  (value) => ({ value, label: roleLabel(value) }),
);

export function TeamManager({
  currentUserId,
  role,
  permissions,
}: {
  currentUserId: string;
  role: string;
  /** The member's effective permission keys — forwarded to the personnel directory. */
  permissions?: readonly string[];
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [locations, setLocations] = useState<TeamLocation[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  /** The member whose full editor dialog is open (name, role, branches, permissions). */
  const [editing, setEditing] = useState<Member | null>(null);
  /** Phase 42 — which member's login-phone editor is open. */
  const [phoneEditing, setPhoneEditing] = useState<Member | null>(null);
  /** Which member's PIN/password reset dialog is open. */
  const [credentialsEditing, setCredentialsEditing] = useState<Member | null>(null);

  const load = useCallback(async () => {
    const [membersRes, invitesRes] = await Promise.all([
      api<{ members: Member[]; locations?: TeamLocation[] }>("/api/team"),
      api<{ invitations: Invitation[] }>("/api/team/invitations"),
    ]);
    if (membersRes.ok) {
      setMembers(membersRes.data.members);
      // Branches travel with the members: assigning a person to a place needs
      // the place's name, and a second permission-gated call for a list this
      // screen already owns would only be a way to make it fail separately.
      if (membersRes.data.locations) setLocations(membersRes.data.locations);
    } else {
      setError(errorMessage((membersRes.data as { error?: string }).error));
    }
    if (invitesRes.ok) {
      setInvitations(invitesRes.data.invitations);
    } else if (membersRes.ok) {
      setError(errorMessage((invitesRes.data as { error?: string }).error));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(url: string, init: RequestInit) {
    setError("");
    const res = await api<{ error?: string; reason?: string }>(url, init);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return false;
    }
    await load();
    return true;
  }

  const locationName = useMemo(
    () => new Map(locations.map((location) => [location.id, location.name])),
    [locations],
  );

  if (loading) return <LoadingSkeleton rows={3} />;
  const isOwner = role === "owner";

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>

      <SectionCard
        title={
          <div>
            <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">مدیریت اعضا</p>
            <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">اعضا و دسترسی‌ها</h2>
          </div>
        }
        description="اعضای کسب‌وکار، نقش‌ها و سطوح دسترسی آن‌ها را در سامانه مدیریت کنید."
      >
        <div className="space-y-3">
          {members.length === 0 ? (
            <InfoBox>هنوز عضوی برای این کسب‌وکار ثبت نشده است.</InfoBox>
          ) : null}
          {members.map((member) => (
            <div key={member.id} className="rounded-xl border border-border/80 p-3 sm:p-4 transition-colors hover:bg-muted/60 dark:hover:bg-muted/50">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">
                    {member.fullName}
                    {member.id === currentUserId && (
                      <span className="ms-2 text-xs font-normal text-muted-foreground">(شما)</span>
                    )}
                    {!member.isActive && (
                      <span className="ms-2 rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">غیرفعال</span>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {roleLabel(member.role)}
                    {member.email ? ` · ${member.email}` : ""}
                    {member.hasPin ? " · ورود با رمز عددی" : ""}
                    {/*
                      * Rendered from the stored policy, not from "is the
                      * assignment list empty". The old inference printed
                      * «همهٔ شعبه‌ها» for a member with no assignment *and* no
                      * home branch — which was true, and was the bug: the row
                      * said it casually rather than flagging that somebody had
                      * business-wide reach nobody had chosen to give them.
                      */}
                    {` · ${branchSummary(member, locationName)}`}
                  </p>
                  <p className="mt-1 text-xs">
                    {member.phone ? (
                      <>
                        <span dir="ltr">{toPersianDigits(formatPhoneDisplay(member.phone))}</span>
                        {member.phoneVerified ? (
                          <span className="ms-2 text-emerald-600 dark:text-emerald-400">موبایل تأییدشده</span>
                        ) : (
                          <span className="ms-2 text-amber-600 dark:text-amber-400">
                            تأییدنشده — در اولین ورود با کد پیامکی تأیید می‌شود
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">بدون شمارهٔ موبایل</span>
                    )}
                  </p>
                </div>
                <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
                  {(isOwner || member.role !== "owner") ? <SecondaryButton onClick={() => setEditing(member)}>ویرایش</SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton onClick={() => setPhoneEditing(member)}>
                    شمارهٔ موبایل
                  </SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton onClick={() => setCredentialsEditing(member)}>
                    رمز ورود
                  </SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton
                    onClick={() => {
                      if (member.isActive && !confirm(`حساب «${member.fullName}» تعلیق شود؟ دسترسی او بلافاصله قطع خواهد شد.`)) return;
                      void mutate(`/api/team/${member.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ isActive: !member.isActive }),
                      });
                    }}
                  >
                    {member.isActive ? "تعلیق" : "فعال‌سازی"}
                  </SecondaryButton> : null}
                  {(isOwner || member.role !== "owner") ? <SecondaryButton
                    onClick={() => {
                      if (!confirm(`«${member.fullName}» از این کسب‌وکار حذف شود؟`)) return;
                      void mutate(`/api/team/${member.id}`, { method: "DELETE" });
                    }}
                    className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    حذف
                  </SecondaryButton> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      {editing ? (
        <MemberEditorDialog
          member={editing}
          locations={locations}
          canManageOwners={isOwner}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      {phoneEditing ? (
        <PhoneEditorDialog
          member={phoneEditing}
          onClose={() => setPhoneEditing(null)}
          onSaved={() => {
            setPhoneEditing(null);
            void load();
          }}
        />
      ) : null}

      {credentialsEditing ? (
        <CredentialsEditorDialog
          member={credentialsEditing}
          onClose={() => setCredentialsEditing(null)}
          onSaved={() => setCredentialsEditing(null)}
        />
      ) : null}

      <InviteSection invitations={invitations} canManageOwners={isOwner} onChanged={load} onError={setError} />
      <AddStaffSection onChanged={load} onError={setError} />

      {/*
        Personnel as parties (scope `team`): a staff member is a counterparty for
        payroll, advances and the phone number the shift lead calls, and those live on
        `parties` with `employee_user_id` pointing back at the account above. Shown
        here rather than in a screen of its own so the two views of one person cannot
        disagree about the name — and so editing a phone number here is editing it
        everywhere, the POS's customer picker included.
      */}
      <div>
        <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300">پروندهٔ کارکنان</p>
        <PartiesSection scope={partyScopeFor("team")} role={role} permissions={permissions} />
      </div>
    </div>
  );
}

/**
 * The full member editor — everything a membership carries that a row of
 * buttons cannot ask for in one line: the name, the role (which re-bases the
 * permission ticks), the branch assignment, the default branch, and the
 * per-permission overrides.
 *
 * The name edit doubles as the repair path for the personnel file: the route
 * keeps the party record named after the member (see `ensureEmployeeParty`),
 * so «علی رضایی» in the list above and «علی رضایی» in the payroll file stay
 * one person.
 */
function MemberEditorDialog({
  member,
  locations,
  canManageOwners,
  onClose,
  onSaved,
}: {
  member: Member;
  locations: TeamLocation[];
  canManageOwners: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(member.fullName);
  const [role, setRole] = useState(member.role);
  const [selected, setSelected] = useState<Set<string>>(new Set(member.effectivePermissions));
  const [branchIds, setBranchIds] = useState<string[]>(member.locationIds);
  /**
   * The branch policy, chosen explicitly rather than inferred from whether the
   * list below happens to be empty. That inference is exactly what used to let
   * a member silently reach every shop in the business (migration 0170).
   */
  const [locationScope, setLocationScope] = useState<LocationScope>(
    isLocationScope(member.locationScope) ? member.locationScope : "home",
  );
  const [defaultLocationId, setDefaultLocationId] = useState(member.defaultLocationId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Re-base the ticks whenever the role changes, so the boxes always show what
  // that role would actually grant.
  function changeRole(next: string) {
    setRole(next);
    setSelected(new Set(roleBasePermissions(next as never)));
  }

  function toggleBranch(id: string, checked: boolean) {
    setBranchIds((current) => {
      const next = checked ? [...current, id] : current.filter((entry) => entry !== id);
      // Unticking the default branch moves the default back to "none chosen"
      // rather than leaving it pointing at a branch the member no longer has.
      if (!checked && defaultLocationId === id) setDefaultLocationId("");
      return next;
    });
  }

  function chooseDefaultBranch(id: string) {
    setDefaultLocationId(id);
    // The default is one of the assigned branches by definition — tick it
    // rather than storing a default the access rules would ignore.
    if (id) setBranchIds((current) => (current.includes(id) ? current : [...current, id]));
  }

  const preset = new Set<string>(roleBasePermissions(role as never));
  const isOwnerRole = role === "owner";

  async function save() {
    const name = fullName.trim();
    if (!name) {
      setError("نام عضو را بنویسید.");
      return;
    }
    setBusy(true);
    setError("");
    const granted = [...selected].filter((p) => !preset.has(p)).sort();
    const revoked = [...preset].filter((p) => !selected.has(p)).sort();
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        fullName: name,
        role,
        // An owner's set is not reducible (permissions.ts), so none is sent.
        ...(isOwnerRole ? {} : { permissions: { granted, revoked } }),
        locationIds: branchIds,
        defaultLocationId: defaultLocationId || null,
        locationScope,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>ویرایش «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="نام و نام خانوادگی *">
            <input
              className={inputClass}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
            />
          </Field>
          <Field label="نقش">
            <SearchableSelect
              value={role}
              onChange={changeRole}
              options={canManageOwners ? ROLE_OPTIONS : ROLE_OPTIONS.filter((option) => option.value !== "owner")}
            />
          </Field>
        </div>

        <Field
          label="دامنهٔ شعبه"
          hint="مشخص کنید این عضو در کدام شعبه‌ها کار می‌کند. پیش‌فرض، محدودترین حالت است."
        >
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ["all", "همهٔ شعبه‌ها", "شعبه‌های آینده را هم شامل می‌شود."],
                ["selected", "شعبه‌های انتخاب‌شده", "فقط مواردی که تیک می‌زنید."],
                ["home", "فقط شعبهٔ اصلی", "فقط شعبهٔ پیش‌فرض این عضو."],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                className={`flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm ${
                  locationScope === value ? "border-primary bg-primary/5" : ""
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="location-scope"
                    checked={locationScope === value}
                    onChange={() => setLocationScope(value)}
                  />
                  <span className="font-medium">{label}</span>
                </span>
                <span className="text-xs text-muted-foreground">{hint}</span>
              </label>
            ))}
          </div>
        </Field>

        {locationScope === "selected" ? (
          <Field label="شعبه‌ها" hint="عضو فقط در شعبه‌های تیک‌خورده کار می‌کند.">
            {locations.length === 0 ? (
              <p className="text-xs text-muted-foreground">شعبه‌ای ثبت نشده است.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {locations.map((location) => (
                  <label key={location.id} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={branchIds.includes(location.id)}
                      onCheckedChange={(checked) => toggleBranch(location.id, checked === true)}
                    />
                    <span>
                      {location.name}
                      {!location.isActive ? (
                        <span className="ms-1 text-xs text-muted-foreground">(غیرفعال)</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Field>
        ) : null}

        <Field label="شعبهٔ پیش‌فرض" hint="شعبه‌ای که ورود این عضو با آن باز می‌شود؛ از میان شعبه‌های انتخاب‌شده.">
          <SearchableSelect
            value={defaultLocationId}
            onChange={chooseDefaultBranch}
            options={[
              { value: "", label: "— انتخاب نشده —" },
              ...locations
                // Only the 'selected' policy constrains the home branch to the
                // ticked list; under 'all' or 'home' any branch of the business
                // is a legitimate home, and filtering by a list that is not
                // being used would offer an empty picker.
                .filter(
                  (location) => locationScope !== "selected" || branchIds.includes(location.id),
                )
                .map((location) => ({ value: location.id, label: location.name })),
            ]}
          />
        </Field>

        {isOwnerRole ? (
          <InfoBox>مالک به همهٔ بخش‌ها دسترسی دارد و دسترسی‌هایش قابل محدود کردن نیست.</InfoBox>
        ) : (
          <Field
            label="دسترسی‌ها"
            hint="تیک‌ها نسبت به نقش پایه خوانده می‌شوند: برداشتن تیکِ پیش‌فرض یعنی گرفتن آن دسترسی، و تیکِ اضافه یعنی اعطای آن."
          >
            <PermissionEditor preset={preset} selected={selected} onChange={setSelected} />
          </Field>
        )}

        {!isOwnerRole ? (
          <AccessChangeSummary
            before={new Set(member.effectivePermissions)}
            after={selected}
          />
        ) : null}

        <DialogFooter>
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={save} disabled={busy}>
            ذخیره
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Phase 42 — set or clear one member's login phone.
 *
 * An owner typing a number proves nothing about who holds it, so whatever is
 * saved here lands *unverified* — the member proves it with an OTP at their
 * next door login (or from the security center), and only then does it
 * become usable for the phone login. The hint says so, because an owner who
 * is not told will assume typing the number was the whole job.
 */
function PhoneEditorDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [phone, setPhone] = useState(member.phone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save() {
    setBusy(true);
    setError("");
    const res = await api<{ error?: string; reason?: string }>(`/api/team/${member.id}`, {
      method: "PATCH",
      body: JSON.stringify({ phone: phone.trim() }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.data.reason || errorMessage(res.data.error));
      return;
    }
    onSaved();
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>شمارهٔ موبایل «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        <Field
          label="شمارهٔ موبایل ورود"
          hint="با کد پیامکی که در اولین ورود به خود عضو می‌رسد تأیید می‌شود؛ خالی بگذارید تا حذف شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121234567"
          />
        </Field>
        <DialogFooter>
          <SecondaryButton onClick={onClose}>انصراف</SecondaryButton>
          <PrimaryButton onClick={save} disabled={busy}>
            ذخیرهٔ شماره
          </PrimaryButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The credential reset — a PIN for the shared-device roles, a password for
 * the email roles, matching `PUT /api/team/:id/credentials` (the owner's
 * force-reset path; a member changing their *own* password must prove the
 * current one, which is the security center's business, not this dialog's).
 *
 * The two are separate buttons and separate requests on purpose: resetting a
 * password changes the person's *platform* login everywhere they are a
 * member, and that deserves its own explicit press rather than riding along
 * with a PIN change.
 */
function CredentialsEditorDialog({
  member,
  onClose,
  onSaved,
}: {
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isPinMember = member.hasPin || (PIN_ROLES as readonly string[]).includes(member.role);
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function resetPin() {
    if (!isValidPin(pin)) {
      setError("رمز عددی باید ۴ تا ۱۲ رقم باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setDone("");
    const res = await api<{ error?: string }>(`/api/team/${member.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ pin }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setPin("");
    setDone("رمز عددی جدید ثبت شد.");
  }

  async function resetPassword() {
    if (password.length < 8) {
      setError("رمز عبور باید حداقل ۸ نویسه باشد.");
      return;
    }
    setBusy(true);
    setError("");
    setDone("");
    const res = await api<{ error?: string }>(`/api/team/${member.id}/credentials`, {
      method: "PUT",
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(errorMessage(res.data.error));
      return;
    }
    setPassword("");
    setDone("رمز عبور جدید ثبت شد؛ ورود این شخص در همهٔ کسب‌وکارهایش با همین رمز باز می‌شود.");
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>رمز ورود «{member.fullName}»</DialogTitle>
        </DialogHeader>
        <ErrorBox>{error}</ErrorBox>
        {done ? <InfoBox>{done}</InfoBox> : null}

        {isPinMember ? (
          <Field
            label={`رمز عددی جدید (${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم)`}
            hint="در هر شعبه باید یکتا باشد."
          >
            <input
              className={`${inputClass} w-48 text-center tracking-[0.25em]`}
              dir="ltr"
              inputMode="numeric"
              maxLength={PIN_MAX_LENGTH}
              value={pin}
              onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
            />
          </Field>
        ) : null}

        {member.hasLogin ? (
          <Field
            label="رمز عبور جدید"
            hint="این رمز برای ورودِ ایمیلی این شخص در همهٔ کسب‌وکارها یکی است."
          >
            <input
              className={inputClass}
              dir="ltr"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
            />
          </Field>
        ) : null}

        {!isPinMember && !member.hasLogin ? (
          <InfoBox>این عضو نه رمز عددی دارد و نه ورود ایمیلی؛ ابتدا نقش یا روش ورودش را در ویرایش عضو تعیین کنید.</InfoBox>
        ) : null}

        <DialogFooter>
          <SecondaryButton onClick={onClose}>بستن</SecondaryButton>
          {isPinMember ? (
            <PrimaryButton onClick={resetPin} disabled={busy || !pin}>
              ثبت رمز عددی
            </PrimaryButton>
          ) : null}
          {member.hasLogin ? (
            <PrimaryButton onClick={resetPassword} disabled={busy || password.length < 8}>
              ثبت رمز عبور
            </PrimaryButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteSection({
  invitations,
  canManageOwners,
  onChanged,
  onError,
}: {
  invitations: Invitation[];
  canManageOwners: boolean;
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("manager");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);

  async function invite() {
    setBusy(true);
    onError("");
    setLink("");
    const res = await api<{ url?: string; error?: string }>("/api/team/invitations", {
      method: "POST",
      body: JSON.stringify({ email, fullName, role }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setLink(res.data.url ?? "");
    setEmail("");
    setFullName("");
    await onChanged();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">دعوت و همکاری</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">دعوت همکار</h2>
        </div>
      }
      description="همکاران جدید را با ارسال لینک دعوت به سیستم اضافه کنید."
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="ایمیل">
          <input
            className={inputClass}
            dir="ltr"
            value={email}
            type="email"
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={setRole}
            options={INVITABLE_ROLES.filter((r) => canManageOwners || r !== "owner").map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
      </div>
      <div className="mt-4">
        <PrimaryButton onClick={invite} disabled={busy || !email || !fullName}>
          ساخت لینک دعوت
        </PrimaryButton>
      </div>

      {link && (
        <div className="mt-4">
          <InfoBox>
            این لینک فقط همین یک‌بار نمایش داده می‌شود. آن را برای همکارتان بفرستید:
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <input className={`${inputClass} min-w-0 flex-1`} aria-label="لینک دعوت" dir="ltr" readOnly value={link} onFocus={(event) => event.currentTarget.select()} />
              <SecondaryButton onClick={() => void navigator.clipboard.writeText(link)}>کپی لینک</SecondaryButton>
            </div>
          </InfoBox>
        </div>
      )}

      {invitations.length > 0 && (
        <ul className="mt-4 divide-y divide-border/80 text-sm">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span>
                {invitation.fullName} · <span dir="ltr">{invitation.email}</span> ·{" "}
                {roleLabel(invitation.role)} ·{" "}
                <span className="text-muted-foreground">
                  {INVITATION_STATUS_LABELS[invitation.status]}
                  {invitation.status === "pending" &&
                    ` تا ${toPersianDigits(formatJalali(new Date(invitation.expiresAt)))}`}
                </span>
              </span>
              {invitation.status === "pending" && (
                <SecondaryButton
                  onClick={async () => {
                    const result = await api<{ error?: string }>(`/api/team/invitations/${invitation.id}`, { method: "DELETE" });
                    if (!result.ok) {
                      onError(errorMessage(result.data.error));
                      return;
                    }
                    await onChanged();
                  }}
                >
                  لغو
                </SecondaryButton>
              )}
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function AddStaffSection({
  onChanged,
  onError,
}: {
  onChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<string>("cashier");
  const [pin, setPin] = useState("");
  // Phase 42 — optional login phone, stored unverified until the member's
  // first OTP proves it (mirrors PhoneEditorDialog above).
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * Switching the role empties the PIN and the phone: a PIN is per-role
   * length-wise identical but per-member unique, and a number typed for one
   * person must not silently ride along into another's account. (Before, the
   * PIN typed for a cashier stayed in the box while the owner picked
   * «آشپزخانه», and if they did not notice, the kitchen member was created
   * with the cashier's intended PIN.)
   */
  function changeRole(next: string) {
    if (next === role) return;
    setRole(next);
    setPin("");
    setPhone("");
  }

  async function add() {
    setBusy(true);
    onError("");
    const res = await api<{ error?: string }>("/api/team", {
      method: "POST",
      body: JSON.stringify({ role, fullName, pin, phone: phone.trim() || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setFullName("");
    setPin("");
    setPhone("");
    await onChanged();
  }

  return (
    <SectionCard
      title={
        <div>
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">پرسنل صندوق و آشپزخانه</p>
          <h2 className="mt-1 text-base sm:text-lg font-semibold text-foreground">افزودن کارکنان صندوق و آشپزخانه</h2>
        </div>
      }
      description="این کارکنان با رمز عددی روی دستگاه مشترک وارد می‌شوند و ایمیل ندارند."
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={changeRole}
            options={PIN_ROLES.map((r) => ({ value: r, label: roleLabel(r) }))}
          />
        </Field>
        <Field
          label={`رمز عددی (${toPersianDigits(PIN_MIN_LENGTH)} تا ${toPersianDigits(PIN_MAX_LENGTH)} رقم)`}
          hint="در هر شعبه باید یکتا باشد."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            maxLength={PIN_MAX_LENGTH}
            value={pin}
            onChange={(e) => setPin(toLatinDigits(e.target.value).replace(/[^0-9]/g, ""))}
          />
        </Field>
        <Field
          label="شمارهٔ موبایل"
          hint="اختیاری؛ برای ورود با پیامک. بار اول با کد تأیید فعال می‌شود."
        >
          <input
            className={inputClass}
            dir="ltr"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="09121234567"
          />
        </Field>
      </div>
      <div className="mt-4">
        {/* The same shape rule the backend gates on (pin-policy.ts) — the
            button says no before the request leaves, instead of answering
            with a 400 after it does. */}
        <PrimaryButton onClick={add} disabled={busy || !fullName.trim() || !isValidPin(pin)}>
          افزودن
        </PrimaryButton>
      </div>
    </SectionCard>
  );
}
