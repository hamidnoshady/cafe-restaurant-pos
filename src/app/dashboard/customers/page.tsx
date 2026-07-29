import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { CustomersManager } from "./customers-manager";

export default async function CustomersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier", "accountant"].includes(session.role)) redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">مشتریان</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          افزودن، ویرایش و حذف مشتریان؛ مشاهدهٔ مانده بدهکار/بستانکار و صورتحساب هر مشتری.
        </p>
      </header>
      <CustomersManager role={session.role} />
    </div>
  );
}
