import { CmsManagerShell } from "../cms-manager-shell";
import { CmsStoreSection } from "../cms-sections";

/** سایت‌ساز اشوبه — فروشگاه: محصولات و سفارش‌های سایت. */
export default function CmsStorePage() {
  return (
    <CmsManagerShell
      title="فروشگاه سایت"
      description="محصولات فروشگاه اینترنتی و سفارش‌هایی که سایت گرفته است."
      assistantContext="فروشگاه اینترنتی را بررسی کن: محصولات منتشرشده، سفارش‌های در انتظار پرداخت و پرداخت‌شده."
    >
      <CmsStoreSection />
    </CmsManagerShell>
  );
}
