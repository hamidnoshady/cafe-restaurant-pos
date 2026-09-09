import { redirect } from "next/navigation";

/**
 * The old generic integrations page. Its WooCommerce connection now lives in
 * the «اتصال‌های فنی» hub — kept as a redirect rather than deleted: this
 * path is in bookmarks, older release notes, and cached shells.
 */
export default async function IntegrationsPage() {
  redirect("/dashboard/connections?tab=woocommerce");
}
