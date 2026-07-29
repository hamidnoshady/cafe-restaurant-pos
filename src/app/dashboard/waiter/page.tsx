import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireFeatureForPage } from "@/lib/features";
import { WaiterBoard } from "./waiter-board";

export default async function WaiterPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["cashier", "waiter"].includes(session.role)) redirect("/dashboard");
  await requireFeatureForPage(session.businessId, "reservations");

  return (
    <div className="mx-auto max-w-[1600px]">
      <header className="mb-4 sm:mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-[#252522]">
          میزهای من
        </h1>
        <p className="mt-1 text-sm text-[#77756F]">
          میزهای تخصیص‌داده‌شده به شما
        </p>
      </header>
      <WaiterBoard />
    </div>
  );
}
