import { redirect } from "next/navigation";

/** Legacy URL retained for bookmarks; the protected section now lives in Settings. */
export default function BackupPage() {
  redirect("/settings/backup");
}
