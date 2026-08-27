"use client";

import { PersianNumberInput } from "@/components/ui/persian-number-input";

/**
 * Phase 13 — the team screen. Three cards:
 *  1. Members — role, branches, status; edit permissions, suspend, remove.
 *  2. Invitations — invite by email, show the link exactly once, revoke.
 *  3. Add staff — PIN-based cashier/waiter/kitchen, who have no email.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ALL_PERMISSIONS,
  isOwnerOnlyPermission,
  roleBasePermissions,
  type Permission,
} from "@/lib/permissions";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ErrorBox, Field, InfoBox, PrimaryButton, SecondaryButton, api, errorMessage, inputClass } from "../ui";

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

/** Roles that sign in with an email and password, so can be invited. */
const INVITABLE_ROLES = ["manager", "accountant", "owner"] as const;
/** Roles that sign in with a PIN on a shared device, so are created directly. */
const PIN_ROLES = ["cashier", "waiter", "kitchen"] as const;

const PERMISSION_LABELS: Record<string, string> = {
  "orders.create": "ثبت سفارش",
  "orders.void": "ابطال سفارش",
  "orders.amend_closed": "ویرایش یا حذف سفارش بسته‌شده",
  "orders.backdate": "ثبت سفارش گذشته",
  "orders.discount": "اعمال تخفیف",
  "payments.take": "دریافت وجه",
  "payments.refund": "بازپرداخت",
  "tables.manage": "مدیریت میزها",
  "reservations.manage": "مدیریت رزرو",
  "kitchen.view": "نمایش آشپزخانه",
  "delivery.manage": "مدیریت ارسال",
  "menu.view": "مشاهدهٔ منو",
  "menu.edit": "ویرایش منو",
  "inventory.view": "مشاهدهٔ انبار",
  "inventory.adjust": "اصلاح موجودی",
  "purchases.manage": "مدیریت خرید",
  "customers.view": "مشاهدهٔ مشتریان",
  "customers.manage": "مدیریت مشتریان",
  "ledger.view": "مشاهدهٔ دفتر",
  "ledger.post": "ثبت سند",
  "ledger.approve": "تأیید سند",
  "ledger.close_period": "بستن دوره",
  "accounts.edit": "ویرایش سرفصل‌ها",
  "reports.view": "مشاهدهٔ گزارش",
  "reports.export": "خروجی گزارش",
  "team.manage": "مدیریت تیم",
  "settings.manage": "تنظیمات",
  "locations.manage": "مدیریت شعبه",
  "backup.manage": "پشتیبان‌گیری",
  "api.manage": "مدیریت کلیدهای API",
};

interface Member {
  id: string;
  role: string;
  fullName: string;
  email: string | null;
  isActive: boolean;
  hasPin: boolean;
  hasLogin: boolean;
  locationIds: string[];
  defaultLocationId: string | null;
  overrides: { granted?: string[]; revoked?: string[] };
  effectivePermissions: string[];
  createdAt: string;
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

export function TeamManager({ currentUserId }: { currentUserId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [membersRes, invitesRes] = await Promise.all([
      api<{ members: Member[] }>("/api/team"),
      api<{ invitations: Invitation[] }>("/api/team/invitations"),
    ]);
    if (membersRes.ok) setMembers(membersRes.data.members);
    else setError(errorMessage((membersRes.data as { error?: string }).error));
    if (invitesRes.ok) setInvitations(invitesRes.data.invitations);
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

  if (loading) return <p className="text-sm text-muted-foreground">در حال بارگذاری…</p>;

  return (
    <div className="space-y-6">
      <ErrorBox>{error}</ErrorBox>

      <section className="rounded-lg border p-4">
        <h2 className="mb-3 font-semibold">اعضا</h2>
        <div className="space-y-2">
          {members.map((member) => (
            <div key={member.id} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {member.fullName}
                    {member.id === currentUserId && (
                      <span className="ms-2 text-xs text-muted-foreground">(شما)</span>
                    )}
                    {!member.isActive && (
                      <span className="ms-2 rounded bg-muted px-2 py-0.5 text-xs">غیرفعال</span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {ROLE_LABELS[member.role] ?? member.role}
                    {member.email ? ` · ${member.email}` : ""}
                    {member.hasPin ? " · ورود با رمز عددی" : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <SecondaryButton
                    onClick={() => setEditing(editing === member.id ? null : member.id)}
                  >
                    دسترسی‌ها
                  </SecondaryButton>
                  <SecondaryButton
                    onClick={() =>
                      mutate(`/api/team/${member.id}`, {
                        method: "PATCH",
                        body: JSON.stringify({ isActive: !member.isActive }),
                      })
                    }
                  >
                    {member.isActive ? "تعلیق" : "فعال‌سازی"}
                  </SecondaryButton>
                  <SecondaryButton
                    onClick={() => {
                      if (!confirm(`«${member.fullName}» از این کسب‌وکار حذف شود؟`)) return;
                      void mutate(`/api/team/${member.id}`, { method: "DELETE" });
                    }}
                  >
                    حذف
                  </SecondaryButton>
                </div>
              </div>

              {editing === member.id && (
                <PermissionEditor
                  member={member}
                  onSave={async (role, overrides) => {
                    const ok = await mutate(`/api/team/${member.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ role, permissions: overrides }),
                    });
                    if (ok) setEditing(null);
                  }}
                />
              )}
            </div>
          ))}
        </div>
      </section>

      <InviteSection invitations={invitations} onChanged={load} onError={setError} />
      <AddStaffSection onChanged={load} onError={setError} />
    </div>
  );
}

/**
 * Role picker plus per-permission toggles.
 *
 * Toggles are expressed against the *chosen role's preset*, so switching role
 * re-bases them: ticking a box the preset already includes stores nothing, and
 * unticking one it includes stores a revoke. That keeps overrides minimal, so
 * a later change to a preset still reaches members who never customised it.
 */
function PermissionEditor({
  member,
  onSave,
}: {
  member: Member;
  onSave: (role: string, overrides: { granted: string[]; revoked: string[] }) => void;
}) {
  const [role, setRole] = useState(member.role);
  const [selected, setSelected] = useState<Set<string>>(new Set(member.effectivePermissions));

  // Re-base the ticks whenever the role changes, so the boxes always show what
  // that role would actually grant.
  function changeRole(next: string) {
    setRole(next);
    setSelected(new Set(roleBasePermissions(next as never)));
  }

  const preset = new Set<string>(roleBasePermissions(role as never));
  const isOwner = role === "owner";

  function save() {
    const granted = [...selected].filter((p) => !preset.has(p)).sort();
    const revoked = [...preset].filter((p) => !selected.has(p)).sort();
    onSave(role, { granted, revoked });
  }

  return (
    <div className="mt-3 space-y-3 border-t pt-3">
      <Field label="نقش">
        <SearchableSelect
          value={role}
          onChange={changeRole}
          options={Object.keys(ROLE_LABELS).map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
        />
      </Field>

      {isOwner ? (
        <InfoBox>مالک به همهٔ بخش‌ها دسترسی دارد و دسترسی‌هایش قابل محدود کردن نیست.</InfoBox>
      ) : (
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-3">
          {ALL_PERMISSIONS.filter((permission) => !isOwnerOnlyPermission(permission)).map((permission: Permission) => (
            <label key={permission} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.has(permission)}
                onChange={(e) => {
                  const next = new Set(selected);
                  if (e.target.checked) next.add(permission);
                  else next.delete(permission);
                  setSelected(next);
                }}
              />
              <span>{PERMISSION_LABELS[permission] ?? permission}</span>
            </label>
          ))}
        </div>
      )}

      <PrimaryButton onClick={save}>ذخیره</PrimaryButton>
    </div>
  );
}

function InviteSection({
  invitations,
  onChanged,
  onError,
}: {
  invitations: Invitation[];
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
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 font-semibold">دعوت همکار</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="ایمیل">
          <input
            className={inputClass}
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={setRole}
            options={INVITABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
        </Field>
      </div>
      <div className="mt-3">
        <PrimaryButton onClick={invite} disabled={busy || !email || !fullName}>
          ساخت لینک دعوت
        </PrimaryButton>
      </div>

      {link && (
        <div className="mt-3">
          <InfoBox>
            این لینک فقط همین یک‌بار نمایش داده می‌شود. آن را برای همکارتان بفرستید:
            <input className={`${inputClass} mt-2`} dir="ltr" readOnly value={link} />
          </InfoBox>
        </div>
      )}

      {invitations.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm">
          {invitations.map((invitation) => (
            <li key={invitation.id} className="flex items-center justify-between gap-2">
              <span>
                {invitation.fullName} · <span dir="ltr">{invitation.email}</span> ·{" "}
                {ROLE_LABELS[invitation.role] ?? invitation.role} ·{" "}
                <span className="text-muted-foreground">
                  {INVITATION_STATUS_LABELS[invitation.status]}
                  {invitation.status === "pending" &&
                    ` تا ${toPersianDigits(formatJalali(new Date(invitation.expiresAt)))}`}
                </span>
              </span>
              {invitation.status === "pending" && (
                <SecondaryButton
                  onClick={async () => {
                    await api(`/api/team/invitations/${invitation.id}`, { method: "DELETE" });
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
    </section>
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
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    onError("");
    const res = await api<{ error?: string }>("/api/team", {
      method: "POST",
      body: JSON.stringify({ role, fullName, pin }),
    });
    setBusy(false);
    if (!res.ok) {
      onError(errorMessage(res.data.error));
      return;
    }
    setFullName("");
    setPin("");
    await onChanged();
  }

  return (
    <section className="rounded-lg border p-4">
      <h2 className="mb-3 font-semibold">افزودن کارکنان صندوق و آشپزخانه</h2>
      <p className="mb-3 text-sm text-muted-foreground">
        این کارکنان با رمز عددی چهاررقمی روی دستگاه مشترک وارد می‌شوند و ایمیل ندارند.
      </p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="نام">
          <input className={inputClass} value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <Field label="نقش">
          <SearchableSelect
            value={role}
            onChange={setRole}
            options={PIN_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }))}
          />
        </Field>
        <Field label="رمز عددی (۴ رقم)">
          <PersianNumberInput
            className={inputClass}
            dir="ltr"
            inputMode="numeric"
            grouping={false}
            allowNegative={false}
            maxLength={4}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </Field>
      </div>
      <div className="mt-3">
        <PrimaryButton onClick={add} disabled={busy || !fullName || pin.length !== 4}>
          افزودن
        </PrimaryButton>
      </div>
    </section>
  );
}
