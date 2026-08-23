import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { PageHeader, PageShell } from "../page-chrome";
import { CustomersManager } from "./customers-manager";

export default async function CustomersPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier", "accountant"].includes(session.role)) redirect("/dashboard");

  return (
    <PageShell>
      <PageHeader
        title="مشتریان"
        description="افزودن، ویرایش و حذف مشتریان؛ مشاهدهٔ مانده بدهکار/بستانکار و صورتحساب هر مشتری."
      />
      <CustomersManager role={session.role} />
    </PageShell>
  );
}
