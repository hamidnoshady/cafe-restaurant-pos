import { redirect } from "next/navigation";

/**
 * The store connection moved to the «اتصال‌های فنی» hub: every technical
 * connection in the product lives there, and the website app manages the
 * sites themselves only. Kept as a redirect — bookmarks, older release
 * notes and cached shells still point at this path.
 */
export default function WpConnectionsRedirect() {
  redirect("/dashboard/connections?tab=woocommerce");
}
