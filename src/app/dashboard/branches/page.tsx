import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { BranchesManager } from "./branches-manager";

/**
 * Phase 14 — branches of this business.
 *
 * Owner-only by default (the `locations.manage` permission preset, which only
 * the owner role carries). Not Phase 9's /dashboard/locations: that page is
 * for on-premise, one-server-per-branch deployments; this one is for branches
 * sharing this same database.
 */
export default async function BranchesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner") redirect("/dashboard");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">مدیریت شعب</h1>
        <p className="text-sm text-muted-foreground">
          افزودن، ویرایش و غیرفعال‌سازی شعب این کسب‌وکار. اعضای تیم را از «اعضای تیم» به هر شعبه اختصاص دهید.
        </p>
      </div>
      <BranchesManager />
    </div>
  );
}
