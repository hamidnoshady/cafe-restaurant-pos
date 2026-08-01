import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";

/** Legacy URL retained for bookmarks; branch management now lives in Settings. */
export default async function BranchesPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner") redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "multi_location");

  redirect("/dashboard/settings?tab=branch-management&branchTab=branches");
}
