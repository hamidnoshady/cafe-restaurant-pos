import { requireWpSection } from "../wp-guard";
import { ProductsSectionHost } from "../store-section-host";

/** محصولات همگام‌شدهٔ فروشگاه — همان بخش کاتالوگ اتصال‌ها، میزبانی‌شده در اپ مدیریت فروشگاه. */
export default async function WpProductsPage() {
  await requireWpSection("products");
  return <ProductsSectionHost />;
}
