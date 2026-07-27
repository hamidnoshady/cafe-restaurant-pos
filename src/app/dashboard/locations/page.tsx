import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { LocationsManager } from "./locations-manager";

/**
 * Phase 9 — cross-*server* rollup. Owner only (see the phase doc's access
 * decision). Not to be confused with Phase 14's /dashboard/branches: this
 * page is for on-premise deployments where each branch runs its own local
 * server and pushes summaries to a central one, distinct from the
 * shared-database multi-branch story branches management covers.
 */
export default async function LocationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner") redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "offline_mode");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">همگام‌سازی شعبه‌ها</h1>
        <p className="text-sm text-muted-foreground">
          برای استقرارهای محلی: مقایسهٔ فروش، بهای تمام‌شده و عملکرد کارکنان شعبه‌هایی که هرکدام سرور
          محلی خود را دارند، به‌همراه مدیریت همگام‌سازی با سرور مرکزی.
        </p>
      </div>
      <LocationsManager />
    </div>
  );
}
