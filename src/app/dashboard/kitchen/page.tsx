import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { KdsBoard } from "./kds-board";

export default async function KitchenPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "kitchen"].includes(session.role))
    redirect("/dashboard");

  return <KdsBoard />;
}
