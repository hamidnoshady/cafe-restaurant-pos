import { redirect } from "next/navigation";

/**
 * The WooCommerce panel moved into the connections hub, where it sits beside
 * the desktop and API-key connections instead of being the only one with a
 * page. Kept as a redirect rather than deleted: this path is in bookmarks, in
 * older release notes, and in the nav of any still-cached shell.
 */
export default async function IntegrationsPage() {
  redirect("/dashboard/connections?tab=woocommerce");
}
