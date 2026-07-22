import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { AiSettings } from "./ai-settings";

export default async function AiSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return (
    <div className="mx-auto max-w-2xl">
      <header className="mb-6">
        <h1 className="text-xl font-bold">دستیار هوشمند</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          سرویس هوش مصنوعی را برای دستیار چت و کمک‌کار راه‌اندازی تنظیم کنید. کلید شما فقط روی سرور
          ذخیره می‌شود و در مرورگر نمایش داده نمی‌شود.
        </p>
      </header>
      <AiSettings />
    </div>
  );
}
