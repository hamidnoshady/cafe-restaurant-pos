import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { featureLockedForPage } from "@/lib/features";
import { FeatureLock } from "@/components/feature-lock";
import { IntegrationsManager } from "./integrations-manager";

export default async function IntegrationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  // Lockable like the AI hub: the page is a shop window for a business that
  // does not have the WooCommerce integration yet, not a closed door.
  const locked = await featureLockedForPage(session.businessId, "integrations");

  return (
    <div className="mx-auto w-full max-w-[1400px]">
      <header className="mb-5 border-b border-stone-200/80 pb-5 sm:mb-6 sm:pb-6">
        <h1 className="text-2xl font-bold tracking-tight text-stone-950 sm:text-[1.7rem]">
          فروشگاه آنلاین (ووکامرس)
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
          اتصال امن فروشگاه ووکامرس؛ همگام‌سازی سفارش، محصول، مشتری، موجودی و قیمت
          به‌همراه ثبت خودکار حسابداری، مدیریت خطا و مغایرت‌گیری.
        </p>
      </header>
      <FeatureLock locked={locked} title="فروشگاه آنلاین (ووکامرس)">
        <IntegrationsManager />
      </FeatureLock>
    </div>
  );
}
