import { redirect } from "next/navigation";
import { WEBSITE_HOME } from "@/app/(app)/websites/website-routes";
import { WP_SECTION_KEYS } from "@/app/(app)/websites/wp/wp-routes";

/**
 * The standalone WordPress manager's old home, forwarding onward.
 *
 * Phase 40 shipped the manager at `/dashboard/wp/*`; it is now one of the two
 * managers inside «مدیریت وب‌سایت» and lives under `/dashboard/website/wp/*`.
 * Bookmarks and saved bottom-nav slots still point at the old prefix, so
 * every one of its routes forwards — one optional catch-all rather than nine
 * files, because there is nothing section-specific about forwarding.
 *
 * One section forwards somewhere else: `connections` is the store's technical
 * connection, and every technical connection in the product lives in the
 * «اتصال‌های فنی» hub now — so it forwards to the hub's WordPress tab.
 *
 * An unknown trailing segment lands on the manager's front page rather than a
 * 404: a URL that used to work should never turn into a dead end, even if the
 * section it named has since been renamed.
 */
export default async function LegacyWpRedirect({
  params,
}: {
  params: Promise<{ section?: string[] }>;
}) {
  const { section } = await params;
  const first = section?.[0];
  if (first === "connections") redirect("/settings/connections?tab=woocommerce");
  const known = (WP_SECTION_KEYS as readonly string[]).includes(first ?? "");
  redirect(known ? `${WEBSITE_HOME}/wp/${section!.join("/")}` : `${WEBSITE_HOME}/wp`);
}
