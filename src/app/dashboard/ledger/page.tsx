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
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">حسابداری</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          تراز آزمایشی، دفتر روزنامه (سندهای خودکار و دستی)، و ثبت سند دستی.
        </p>
      </header>
      <LedgerManager role={session.role} />
    </div>
  );
}
