import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WooCommercePanel } from "../../connections/woocommerce-panel";

/**
 * The store connection surfaces, inside the WP Manager app.
 *
 * Reuses the existing WooCommerce panel wholesale — connection create/rotate/
 * settings live there, and duplicating them would make the two doors drift.
 * The panel's own links to the store sections still work (they point at the
 * /dashboard/connections hub routes, which remain module-gated in the flat
 * nav); the manager app's sections are the richer home for the same data.
 */
export default async function WpConnectionsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return <WooCommercePanel />;
}
