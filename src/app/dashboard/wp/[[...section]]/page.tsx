import { redirect } from "next/navigation";
import { WEBSITE_HOME } from "../../website/website-routes";
import { WP_SECTION_KEYS } from "../../website/wp/wp-routes";

/**
 * The standalone WordPress manager's old home, forwarding into «مدیریت
 * وب‌سایت».
 *
 * Phase 40 shipped the manager at `/dashboard/wp/*`; it is now one of the two
 * managers inside the website app and lives under `/dashboard/website/wp/*`.
 * Bookmarks, saved bottom-nav slots and the workspace rail's preference list
 * all still point at the old prefix, so every one of its routes forwards —
 * one optional catch-all rather than nine files, because there is nothing
 * section-specific about forwarding.
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
  const known = (WP_SECTION_KEYS as readonly string[]).includes(first ?? "");
  redirect(known ? `${WEBSITE_HOME}/wp/${section!.join("/")}` : `${WEBSITE_HOME}/wp`);
}
