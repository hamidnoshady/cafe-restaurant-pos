import { redirect } from "next/navigation";

/** Legacy URL retained for bookmarks; the protected section now lives in Settings. */
export default function LocationsPage() {
  redirect("/dashboard/settings?tab=branch-sync");
}
