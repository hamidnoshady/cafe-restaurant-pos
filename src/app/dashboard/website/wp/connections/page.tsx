import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WpConnectionPanel } from "../woocommerce-connection-panel";

/**
 * The store connection surfaces, inside the WP Manager app.
 *
 * Reuses the existing WooCommerce panel wholesale — connection create/rotate/
 * settings live there, and duplicating them would make the two doors drift.
 * This is now the only owner-facing WooCommerce connection screen. The rest of
 * this app owns products, orders, customers, taxonomies, content, media and
 * the sync queue; the generic technical connection hub no longer renders Woo.
 */
export default async function WpConnectionsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return <WpConnectionPanel />;
}
