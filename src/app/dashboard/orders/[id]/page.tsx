import { redirect } from "next/navigation";
import { getSession, type Role } from "@/lib/auth";
import { query, withTenant } from "@/lib/db";
import { effectivePermissions, parseOverrides, PERMISSIONS } from "@/lib/permissions";
import { OrderDetail } from "./order-detail";

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier", "waiter"].includes(session.role)) redirect("/dashboard");
  const { id } = await params;

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
  const canAmendClosed = member
    ? effectivePermissions(member.role, parseOverrides(member.permissions)).has(PERMISSIONS.ordersAmendClosed)
    : false;

  return (
    <OrderDetail
      orderId={id}
      canEdit={["owner", "manager", "cashier"].includes(session.role)}
      canAmendClosed={canAmendClosed}
    />
  );
}
