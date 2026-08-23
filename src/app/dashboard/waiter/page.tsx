import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { requireFeatureForPage } from "@/lib/features";
import { PageHeader, PageShell } from "../page-chrome";
import { WaiterBoard } from "./waiter-board";

export default async function WaiterPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "waiter");
  if (!["cashier", "waiter"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "reservations");

  return (
    <PageShell>
      <PageHeader title="میزهای من" description="میزهای تخصیص‌داده‌شده به شما" />
      <WaiterBoard />
    </PageShell>
  );
}
