import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS } from "@/lib/permissions";
import { requireModuleForPage } from "@/lib/industry-guard";
import { PageHeader, PageShell } from "@/app/dashboard/page-chrome";
import { MediaManager } from "@/app/dashboard/media/media-manager";

/**
 * «کتابخانهٔ رسانه» (migration 0149) — the platform-wide media section: one
 * shared library of the business's images, videos and documents, organized
 * with visual folders and categories/tags, with AI auto-tagging the operator
 * confirms and the optional product-shot refine. Owner/manager only, like
 * the menu and the inventory whose pickers read from it.
 */
export default async function MediaPage() {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  const permissions = access?.permissions ?? new Set<string>();
  if (!permissions.has(PERMISSIONS.settingsManage)) redirect("/dashboard");
  await requireModuleForPage(session.businessId, "media");

  return (
    <PageShell>
      <PageHeader
        title="کتابخانهٔ رسانه"
        description="تصاویر، ویدیوها و اسناد کسب‌وکار در یک کتابخانهٔ مشترک: پوشه‌بندی، دسته‌بندی و برچسب، تشخیص هوشمند محتوا با تأیید شما و تولید تصویر استاندارد محصول."
      />
      <MediaManager />
    </PageShell>
  );
}
