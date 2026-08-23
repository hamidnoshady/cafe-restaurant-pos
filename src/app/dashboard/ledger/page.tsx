import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../page-chrome";
import { LedgerManager } from "./ledger-manager";

export default async function LedgerPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "ledger");

  return (
    <PageShell>
      <PageHeader
        title="حسابداری"
        description="تراز آزمایشی، دفتر روزنامه، اسناد دستی و عملیات مالی کسب‌وکار."
      />
      <LedgerManager role={session.role} />
    </PageShell>
  );
}
