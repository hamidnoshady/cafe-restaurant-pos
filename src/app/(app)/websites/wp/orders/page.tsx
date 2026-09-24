import { requireWpSection } from "../wp-guard";
import { OrdersSectionHost } from "../store-section-host";

/** سفارش‌های فروشگاه: تغییر وضعیت و برگشت وجه، از طریق صف عملیات. */
export default async function WpOrdersPage() {
  await requireWpSection("orders");
  return <OrdersSectionHost />;
}
