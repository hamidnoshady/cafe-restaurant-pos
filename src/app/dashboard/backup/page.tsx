import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { BackupManager } from "./backup-manager";

/** Phase 10 — backups. Owner/Manager see status + "backup now"; config is Owner-only. */
export default async function BackupPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "backup");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">پشتیبان‌گیری</h1>
        <p className="text-sm text-muted-foreground">
          نسخهٔ پشتیبان کل پایگاه‌داده روی دیسک محلی و — به‌صورت رمزنگاری‌شده — در فضای ابری.
          بازگردانی طبق راهنمای docs/backup-restore.md انجام می‌شود.
        </p>
      </div>
      <BackupManager isOwner={session.role === "owner"} />
    </div>
  );
}
