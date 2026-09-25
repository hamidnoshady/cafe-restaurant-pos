import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { canOpenWebsiteApp } from "./website-routes";

/**
 * «مدیریت وب‌سایت» — the app boundary for both website managers.
 *
 * The app is one door with two rooms: the Eshobe CMS site builder (`cms/`)
 * and the WordPress/WooCommerce manager (`wp/`). This layout owns only what
 * both halves share — the role line. Everything else is deliberately not
 * here:
 *
 *   * the sidebar comes from src/lib/app-shells.ts, which hands the dashboard's
 *     nav slot to `website-app-nav.tsx` for every route under this prefix;
 *   * the page frame and header belong to each manager, because the two are
 *     different products with different words for the same nouns;
 *   * the `integrations` entitlement is applied by `wp/layout.tsx` alone. It
 *     gates the WordPress half only: a business that never bought the
 *     integrations add-on still runs the platform site it pays for here.
 *
 * Both managers write to a live public site and read the whole order book
 * behind it, so both are owner/manager work.
 */
export default async function WebsiteAppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  if (!canOpenWebsiteApp(access?.permissions ?? new Set())) redirect("/dashboard");
  return <>{children}</>;
}
