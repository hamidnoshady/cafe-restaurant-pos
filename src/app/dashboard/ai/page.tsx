import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { AiBillingDashboard } from "./ai-billing";
import { AiProactiveSettings } from "./ai-proactive-settings";

export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "ai_assistant");

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-xl font-bold">دستیار هوشمند</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          ماندهٔ اعتبار، اشتراک، گزارش‌های خودکار و درخواست شارژ دستیار هوشمند را مدیریت کنید. اتصال و کلید سرویس فقط توسط مدیر پلتفرم مدیریت می‌شود.
        </p>
      </header>
      <div className="space-y-5">
        <AiProactiveSettings />
        <AiBillingDashboard />
      </div>
    </div>
  );
}
