import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WpQueueSection } from "../queue-section";

/** صف عملیات خروجی و رویدادهای ورودی ناموفق. */
export default async function WpQueuePage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  return <WpQueueSection />;
}
