import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { canOpenWebsiteApp } from "../website-routes";
import { WebsiteSettingsSection } from "../settings-section";

/**
 * `/websites/settings` — the website app's own settings.
 *
 * Its own route and its own component. It is neither the platform settings page
 * (`/settings`, which configures the business) nor the CMS's sync settings
 * (`/websites/cms/settings`, which configures one manager): this page is about
 * the app itself, and it links to the other two by name.
 */
export default async function WebsiteSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  if (!canOpenWebsiteApp(access?.permissions ?? new Set())) redirect("/dashboard");

  return <WebsiteSettingsSection />;
}
