import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { WpMediaSection } from "../media-section";

/** کتابخانهٔ رسانه‌های فروشگاه (تصاویر و فایل‌های پیوست). */
export default async function WpMediaPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  return <WpMediaSection />;
}
