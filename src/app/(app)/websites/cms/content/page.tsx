import { CmsManagerShell } from "../cms-manager-shell";
import { CmsContentSection } from "../cms-sections";

/** سایت‌ساز اشوبه — محتوا: صفحه‌ها و نوشته‌های سایت. */
export default function CmsContentPage() {
  return (
    <CmsManagerShell
      title="محتوای سایت"
      description="صفحه‌ها و نوشته‌های سایت. نوشتهٔ ساخته‌شده از این‌جا پیش‌نویس است؛ انتشار در پنل سایت‌ساز انجام می‌شود."
      assistantContext="محتوای سایت را بررسی کن: صفحه‌ها و نوشته‌های منتشرشده و پیش‌نویس‌ها."
    >
      <CmsContentSection />
    </CmsManagerShell>
  );
}
