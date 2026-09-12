import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { canViewGrowthSection, growthSectionHref } from "../growth-routes";
import { GrowthSettingsSection } from "../settings-section";

/**
 * `/growth/settings` — the Growth app's own settings.
 *
 * Its own route and its own component: it must never render the platform
 * settings page, and it must not redirect to `/settings` — `/settings` is the
 * business/platform settings area, and the two configure different things.
 */
export default async function GrowthSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "settings")) {
    redirect(growthSectionHref(session.role === "cashier" ? "loyalty" : "overview"));
  }
  return <GrowthSettingsSection />;
}
