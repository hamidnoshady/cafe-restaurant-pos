import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { SubscriptionManager } from "./subscription-manager";

export const metadata = { title: "اشتراک پلتفرم" };

/**
 * `/settings/subscription` — the business's plan, at the platform level.
 *
 * Platform-owned like billing beside it: an app may link here, and the heading
 * names the platform so the member can see they left the app they came from.
 */
export default async function PlatformSubscriptionPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return (
    <PageShell className="max-w-[1500px]">
      <PageHeader
        title="اشتراک پلتفرم"
        description="طرح فعلی کسب‌وکار و ارتقای آن. این صفحه متعلق به پلتفرم است و روی همهٔ برنامه‌ها اثر دارد."
      />
      <SubscriptionManager />
    </PageShell>
  );
}
