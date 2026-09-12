"use client";

/**
 * The member's own account card, and the controls that are genuinely theirs.
 *
 * Read-only where the business owns the value: a member's name, role and phone
 * are set by whoever manages the team, so this page *shows* them and points at
 * the person who can change them rather than offering a field that would fail.
 * Two-factor enrolment is the opposite — the session's own second factor — so
 * the existing self-service panel is mounted here in full.
 */

import Link from "next/link";
import { ShieldCheckIcon, UserRoundIcon } from "lucide-react";
import { toPersianDigits } from "@/lib/digits";
import { SectionCard } from "@/app/dashboard/page-chrome";
import { TwoFactorSettings } from "../two-factor-settings";

const ROLE_LABELS: Record<string, string> = {
  owner: "مالک",
  manager: "مدیر",
  accountant: "حسابدار",
  cashier: "صندوق‌دار",
  waiter: "گارسون",
  kitchen: "آشپزخانه",
};

export function ProfileSection({
  fullName,
  phone,
  role,
  isOwner,
}: {
  fullName: string;
  phone: string | null;
  role: string;
  isOwner: boolean;
}) {
  return (
    <div className="space-y-4">
      <SectionCard
        title="مشخصات شما"
        description="این اطلاعات را مدیر تیم تغییر می‌دهد."
      >
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">نام</dt>
            <dd className="mt-1 flex items-center gap-2 font-semibold text-foreground">
              <UserRoundIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              {fullName}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">نقش</dt>
            <dd className="mt-1 font-semibold text-foreground">{ROLE_LABELS[role] ?? role}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">شمارهٔ ورود</dt>
            <dd className="mt-1 font-semibold tabular-nums text-foreground">
              {phone ? toPersianDigits(phone) : "—"}
            </dd>
          </div>
        </dl>
        {["owner", "manager"].includes(role) ? (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            برای تغییر نام یا شمارهٔ اعضا، به{" "}
            <Link href="/settings/team" className="font-medium text-foreground underline-offset-4 hover:underline">
              اعضای تیم
            </Link>{" "}
            بروید.
          </p>
        ) : (
          <p className="mt-4 text-sm leading-6 text-muted-foreground">
            برای تغییر نام یا شمارهٔ ورود، از مدیر کسب‌وکار بخواهید آن را در «اعضای تیم» به‌روز کند.
          </p>
        )}
      </SectionCard>

      <div className="flex items-center gap-2 px-1 text-sm font-semibold text-foreground">
        <ShieldCheckIcon aria-hidden="true" className="size-4 shrink-0 text-amber-700 dark:text-amber-300" />
        ورود دومرحله‌ای
      </div>
      <TwoFactorSettings isOwner={isOwner} />
    </div>
  );
}
