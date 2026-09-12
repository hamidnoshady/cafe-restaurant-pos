import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { ProductsSectionHost } from "../store-section-host";

/** محصولات همگام‌شدهٔ فروشگاه — همان بخش کاتالوگ اتصال‌ها، میزبانی‌شده در اپ مدیریت فروشگاه. */
export default async function WpProductsPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  return <ProductsSectionHost />;
}
