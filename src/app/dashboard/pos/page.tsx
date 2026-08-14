import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { requireModuleForPage } from "@/lib/industry-guard";
import { PosScreen } from "./pos-screen";

export default async function PosPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "pos");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  return <PosScreen />;
}
