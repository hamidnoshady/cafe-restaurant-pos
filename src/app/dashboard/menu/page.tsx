import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { MenuManager } from "./menu-manager";

export default async function MenuPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">مدیریت منو</h1>
        <p className="mt-1 text-sm text-stone-500">
          دسته‌ها، آیتم‌ها و افزودنی‌ها — مستقل از ورود اولیهٔ جادوگر راه‌اندازی.
        </p>
      </header>
      <MenuManager />
    </div>
  );
}
