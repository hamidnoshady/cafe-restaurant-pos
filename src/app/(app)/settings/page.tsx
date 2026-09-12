import { redirect } from "next/navigation";
import { canonicalSettingsHrefForTabParam } from "@/lib/settings-routes";
import { SettingsPageBody } from "./settings-page-body";

/**
 * `/settings` — the platform settings home.
 *
 * The area's sections are real routes now, so the one thing this page still
 * owes the old world is the `?tab=` deep link: every guide, notification and
 * saved bookmark that names a section by query parameter is forwarded to that
 * section's URL, once, and the address bar ends up canonical.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  // The old `server-sync` tab is a technical connection now and lives in the
  // «اتصال‌های فنی» hub.
  if (tab === "server-sync") redirect("/settings/connections?tab=server_sync");
  const canonical = canonicalSettingsHrefForTabParam(tab ?? null);
  if (canonical) redirect(canonical);

  return <SettingsPageBody />;
}
