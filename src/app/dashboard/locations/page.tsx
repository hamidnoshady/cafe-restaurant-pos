import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LocationsManager } from "./locations-manager";

/** Phase 9 — cross-location rollup. Owner only (see the phase doc's access decision). */
export default async function LocationsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner") redirect("/dashboard");

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <h1 className="text-xl font-bold">شعبه‌ها</h1>
        <p className="text-sm text-muted-foreground">
          مقایسهٔ فروش، بهای تمام‌شده و عملکرد کارکنان شعبه‌ها؛ به‌همراه مدیریت همگام‌سازی با سرور مرکزی.
        </p>
      </div>
      <LocationsManager />
    </div>
  );
}
