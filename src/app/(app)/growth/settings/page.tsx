import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
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
  // The member's live effective permissions — the same set the API enforces,
  // so the page and the fetches inside it can never disagree about access.
  const access = await memberAccessFor(session);
  const permissions: ReadonlySet<string> = access?.permissions ?? new Set<string>();
  if (!canViewGrowthSection(permissions, "settings")) redirect(growthFallbackHref(permissions));

  return <GrowthSection section="settings" role={session.role} />;
}
