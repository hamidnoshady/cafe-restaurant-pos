import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { ProfileSection } from "./profile-section";

export const metadata = { title: "حساب کاربری" };

/**
 * `/settings/profile` — the signed-in member's own account.
 *
 * A platform page, and the only settings URL every role can open: the tabs of
 * the settings manager are all owner/manager configuration of the *business*,
 * so a cashier who tapped «تنظیمات پلتفرم» used to be bounced straight back to
 * the dashboard. Their own name, role, branch and second factor are theirs to
 * see, and they are not business configuration, so they live here rather than
 * as a seventeenth tab nobody but an owner could reach.
 */
export default async function ProfilePage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const { rows } = await withTenant(
    session.businessId,
    () =>
      query<{ full_name: string; phone: string | null; created_at: string }>(
        "SELECT full_name, phone, created_at FROM users WHERE id = $1 AND business_id = $2",
        [session.sub, session.businessId],
      ),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];

  return (
    <PageShell className="max-w-[1100px]">
      <PageHeader
        title="حساب کاربری"
        description="نام، نقش و ورود دومرحله‌ای شما در این کسب‌وکار. تنظیمات کسب‌وکار جای دیگری است."
      />
      <ProfileSection
        fullName={member?.full_name ?? session.fullName}
        phone={member?.phone ?? null}
        role={session.role}
        isOwner={session.role === "owner"}
      />
    </PageShell>
  );
}
