import { redirect } from "next/navigation";
import { PLATFORM_SETTINGS_HOME } from "@/lib/app-routes";
import { isPlatformSettingsPage, settingsTabForSlug } from "@/lib/settings-routes";
import { SettingsPageBody } from "../settings-page-body";

/**
 * One platform settings section per URL — `/settings/team`, `/settings/tax`,
 * `/settings/printers`.
 *
 * The settings manager's sections all render through the same body, so this
 * dynamic segment answers for every one of them; the sections that are *not*
 * tabs (profile, billing, subscription, connections) are real directories
 * beside this file and never reach here. Anything else is a settings URL that
 * does not exist, and it goes to the settings home rather than to a 404 — a
 * mistyped or retired settings link should still land somebody in settings.
 */
export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  // A static sibling route owns these; reaching them here would mean the
  // directory was removed, and rendering the tab body would be wrong.
  if (isPlatformSettingsPage(section)) redirect(`${PLATFORM_SETTINGS_HOME}/${section}`);

  const tab = settingsTabForSlug(section);
  if (!tab) redirect(PLATFORM_SETTINGS_HOME);

  return <SettingsPageBody section={tab} />;
}
