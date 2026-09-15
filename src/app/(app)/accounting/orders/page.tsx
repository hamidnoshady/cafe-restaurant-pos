import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { requireModuleForPage } from "@/lib/industry-guard";
import { effectivePermissions, parseOverrides, PERMISSIONS } from "@/lib/permissions";
import { OrdersList } from "@/app/dashboard/orders/orders-list";

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
  // edit rights — see permissions.ts. Read the member's effective set the same
  // way the settings page does (explicit withTenant scope, not the ambient one).
  const { rows } = await withTenant(
    session.businessId,
    () =>
      query<{ role: Role; permissions: unknown }>(
        "SELECT role, permissions FROM users WHERE id = $1 AND business_id = $2",
        [session.sub, session.businessId],
      ),
    { locationId: session.locationId, userId: session.sub },
  );
  const member = rows[0];
  const permissions = member
    ? effectivePermissions(member.role, parseOverrides(member.permissions))
    : null;
  const canAmendClosed = permissions?.has(PERMISSIONS.ordersAmendClosed) ?? false;
  // Recording a sale that already happened is its own permission again — see
  // permissions.ts. Nothing about the till's edit rights implies it.
  const canBackdate = permissions?.has(PERMISSIONS.ordersBackdate) ?? false;

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
