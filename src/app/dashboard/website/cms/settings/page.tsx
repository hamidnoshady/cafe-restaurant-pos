import { CmsManagerShell } from "../cms-manager-shell";
import { CmsSettingsSection } from "../cms-sections";

/** سایت‌ساز اشوبه — تنظیمات اتصال و همگام‌سازی یک‌طرفهٔ قیمت و موجودی. */
export default function CmsSettingsPage() {
  return (
    <CmsManagerShell
      title="تنظیمات و همگام‌سازی"
      description="اتصال سایت به این حساب، و اینکه چه چیزی از صندوق به سایت فرستاده شود — قیمت و موجودی، یک‌طرفه."
      assistantContext="تنظیمات همگام‌سازی سایت را بررسی کن: ارسال قیمت و موجودی، محصولات علامت‌خورده و صف ارسال."
    >
      <CmsSettingsSection />
    </CmsManagerShell>
  );
}
