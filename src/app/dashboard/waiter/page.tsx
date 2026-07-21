import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WaiterBoard } from "./waiter-board";

export default async function WaiterPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "waiter"].includes(session.role)) redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">میزهای من</h1>
      </header>
      <WaiterBoard />
    </div>
  );
}
