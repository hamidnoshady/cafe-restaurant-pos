import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { StepNav } from "./step-nav";

export default async function SetupLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl gap-6 p-4 sm:p-6">
      <aside className="hidden w-60 shrink-0 sm:block">
        <div className="sticky top-6 rounded-2xl bg-card p-4 shadow-sm">
          <p className="mb-1 font-bold">راه‌اندازی اولیه</p>
          <p className="mb-4 text-xs text-muted-foreground">
            گام‌به‌گام تا آماده‌شدن برای ثبت سفارش
          </p>
          <StepNav />
        </div>
      </aside>
      <main className="min-w-0 flex-1 rounded-2xl bg-card p-6 shadow-sm">{children}</main>
    </div>
  );
}
