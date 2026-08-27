import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../../page-chrome";
import { HolooMigrationWizard } from "./wizard";

/** Standalone Holoo migration wizard — not part of first-run setup. */
export default async function HolooMigrationPage({
  searchParams,
}: {
  searchParams: Promise<{ connectionId?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "integrations");
  const { connectionId } = await searchParams;

  return (
    <PageShell>
      <PageHeader
        title="ویزارد مهاجرت هلو"
        description="اتصال را انتخاب کنید، مانیفست خروجی/پروفایل هلو را پیش‌نمایش بگیرید، وارد کنید، اختلاف‌ها را ببینید و در صورت نیاز همان run را rollback کنید."
      />
      <HolooMigrationWizard initialConnectionId={connectionId ?? null} />
    </PageShell>
  );
}
