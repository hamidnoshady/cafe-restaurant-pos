import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { LedgerManager } from "./ledger-manager";

export default async function LedgerPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">حسابداری</h1>
        <p className="mt-1 text-sm text-stone-500">
          تراز آزمایشی، دفتر روزنامه (سندهای خودکار و دستی)، و ثبت سند دستی.
        </p>
      </header>
      <LedgerManager />
    </div>
  );
}
