import { redirect } from "next/navigation";

/**
 * The WooCommerce manager moved out of the generic connections hub into its
 * own WP Manager app. Kept as a redirect rather than deleted: this path is in
 * bookmarks, older release notes, and cached shells.
 */
export default async function IntegrationsPage() {
  redirect("/dashboard/wp/connections");
}
