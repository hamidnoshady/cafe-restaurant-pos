import { requireWpSection } from "../wp-guard";
import { WpMediaSection } from "../media-section";

/** کتابخانهٔ رسانه‌های فروشگاه (تصاویر و فایل‌های پیوست). */
export default async function WpMediaPage() {
  await requireWpSection("media");
  return <WpMediaSection />;
}
