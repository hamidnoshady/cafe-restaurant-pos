import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { OrdersList } from "./orders-list";

export default async function OrdersPage({
  searchParams,
}: {
  /** `?order=<id>` opens that order's dialog straight away — see [id]/page.tsx. */
  searchParams: Promise<{ order?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "orders");
  if (!["owner", "manager", "cashier", "waiter"].includes(session.role))
    redirect("/dashboard");

  // Amending a *closed* order is its own permission, not part of the till's
  // edit rights — see permissions.ts. The member's effective set comes from
  // the one shared read (member-access.ts): explicit withTenant scope inside,
  // so it cannot come back empty non-deterministically.
  const member = await memberAccessFor(session);
  const canAmendClosed = member?.permissions.has(PERMISSIONS.ordersAmendClosed) ?? false;
  // Recording a sale that already happened is its own permission again — see
  // permissions.ts. Nothing about the till's edit rights implies it.
  const canBackdate = member?.permissions.has(PERMISSIONS.ordersBackdate) ?? false;

  const { order } = await searchParams;

  return (
    <OrdersList
      canEdit={["owner", "manager", "cashier"].includes(session.role)}
      canAmendClosed={canAmendClosed}
      canBackdate={canBackdate}
      initialOrderId={order ?? null}
    />
  );
}
