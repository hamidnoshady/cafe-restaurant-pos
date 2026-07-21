import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { KdsBoard } from "./kds-board";

export default async function KitchenPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "kitchen"].includes(session.role)) redirect("/dashboard");

  return (
    <div>
      <header className="mb-6">
        <h1 className="text-2xl font-bold">نمایشگر آشپزخانه</h1>
      </header>
      <KdsBoard />
    </div>
  );
}
