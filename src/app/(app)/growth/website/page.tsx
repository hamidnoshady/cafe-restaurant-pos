import { redirect } from "next/navigation";

/**
 * The website manager moved out of Growth & Marketing into its own app
 * (src/lib/apps.ts) — an integration with an external system of record
 * (eshobe-cms), not a marketing engine. This route stays so every bookmark,
 * saved bottom-nav slot and assistant link keeps working.
 */
export default function GrowthWebsiteRedirect() {
  redirect("/websites/overview");
}
