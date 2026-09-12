import { redirect } from "next/navigation";

/** Legacy URL retained for bookmarks; branch synchronization now lives in Settings. */
export default function LocationsPage() {
  redirect("/settings/branch-management?branchTab=sync");
}
