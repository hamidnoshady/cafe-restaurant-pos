import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { BillingManager } from "./billing-manager";

export const metadata = { title: "صورت‌حساب پلتفرم" };

/**
 * `/settings/billing` — the platform's billing page.
 *
 * Deliberately part of the platform settings area rather than of any app.
 * Accounting, Growth and the website builder all *link* here, and the title
 * says «پلتفرم» out loud so a member who followed one of those links knows
 * they left the app: an in-app billing screen that was really the platform's
 * was exactly the confusion this address removes.
 */
export default async function PlatformBillingPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  // Only owner/manager spend business money.
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.settingsManage)) redirect("/dashboard");

  return (
    <PageShell className="max-w-[1500px]">
      <PageHeader
        title="صورت‌حساب پلتفرم"
        description="اعتبار کسب‌وکار، شارژ حساب و تاریخچهٔ پرداخت‌ها. این صفحه متعلق به پلتفرم است، نه به یک برنامهٔ خاص."
      />
      <BillingManager />
    </PageShell>
  );
}
