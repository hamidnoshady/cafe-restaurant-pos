import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { LedgerManager } from "./ledger-manager";

export default async function LedgerPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "accountant"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "ledger");

  return (
    <div className="mx-auto max-w-[1680px]">
      <header className="mb-4 rounded-2xl border border-[#EAE8E2] bg-[#FFFEFC] px-4 py-5 shadow-[0_1px_2px_rgb(41_37_36/0.03)] sm:mb-5 sm:px-6">
        <p className="mb-2 text-xs font-semibold tracking-wide text-[#9B6700]">مدیریت مالی</p>
        <h1 className="text-2xl font-bold tracking-tight text-[#252522] sm:text-3xl">حسابداری</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#77756F]">
          تراز آزمایشی، دفتر روزنامه، اسناد دستی و عملیات مالی کسب‌وکار.
        </p>
      </header>
      <LedgerManager role={session.role} />
    </div>
  );
}
