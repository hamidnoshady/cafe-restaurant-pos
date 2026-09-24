import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

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
  if (!canViewGrowthSection(session.role, "settings")) redirect(growthFallbackHref(session.role));

  return <GrowthSection section="settings" role={session.role} />;
}
