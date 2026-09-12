import Link from "next/link";
import { GlobeIcon, PlugZapIcon, WandSparklesIcon } from "lucide-react";
import { getSession } from "@/lib/auth";
import { PageHeader, PageShell, SectionCard, StatusBadge } from "@/app/dashboard/page-chrome";
import { KnowledgeHelpButton } from "@/app/dashboard/knowledge-help";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { Button } from "@/components/ui/button";
import { websiteManagersState } from "@/lib/website/managers-service";
import { completedStepCount, WEBSITE_SETUP_STEP_KEYS } from "@/lib/website/setup";
import { toPersianDigits } from "@/lib/digits";
import { getWebsiteSetup } from "@/lib/website/setup-service";
import { cmsSectionHref, wpSectionHref } from "./website-routes";

/**
 * «مدیریت وب‌سایت» — the app home: the two ways a business can have a website,
 * side by side, each showing whether it is actually set up.
 *
 * Two cards rather than a chooser that disappears once one is picked: a
 * business may well run both (a WordPress shop it already had, and a platform
 * site for the café's menu and reservations), and the one it has not set up
 * is the one it is most likely to be looking for. What each card shows is
 * *observed* — a live connection row, not a flag — so «متصل» here and a
 * working section behind it can never disagree.
 */
export async function WebsiteAppHome() {
  const session = await getSession();
  // The layout has already refused anyone who may not be here; this is only
  // to read the business id.
  const managers = session ? await websiteManagersState(session.businessId) : null;
  const setup = session ? await getWebsiteSetup(session.businessId) : null;
  const built = setup ? completedStepCount(setup) : 0;

  return (
    <PageShell className="space-y-4 sm:space-y-5">
      <PageHeader
        title="مدیریت وب‌سایت"
        description="سایت کسب‌وکار، از هر دو راه: سایت‌ساز اشوبه یا سایت وردپرسی خودتان. هرکدام بخش مدیریت جدای خودش را دارد."
        actions={
          <>
            <KnowledgeHelpButton section="website" />
            <AskAssistant
              app="website"
              context="وضعیت وب‌سایت کسب‌وکار را بررسی کن: سایت روی سایت‌ساز پلتفرم و فروشگاه وردپرسی، اتصال‌ها و سفارش‌های آنلاین."
            />
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard
          title="سایت‌ساز اشوبه"
          description="سایت و فروشگاه اینترنتی روی پلتفرم خودمان: دامنه، CDN آروان، محتوا، فروشگاه و صورت‌حساب — همه از همین‌جا."
          actions={
            <StatusBadge tone={managers?.cms.connected ? "positive" : "neutral"}>
              {managers?.cms.connected ? "متصل" : "راه‌اندازی نشده"}
            </StatusBadge>
          }
        >
          {managers?.cms.connected ? (
            <p className="text-sm leading-6 text-muted-foreground">
              سایت روی دامنهٔ{" "}
              <span dir="ltr" className="font-medium text-foreground">
                {managers.cms.domain}
              </span>{" "}
              فعال است.
            </p>
          ) : (
            <p className="text-sm leading-6 text-muted-foreground">
              ساخت سایت چهار گام دارد: دامنه، CDN، نوع سایت و ساخت.{" "}
              {built > 0
                ? `${toPersianDigits(built)} گام از ${toPersianDigits(WEBSITE_SETUP_STEP_KEYS.length)} گام انجام شده است.`
                : "هنوز شروع نشده است."}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {managers?.cms.connected ? (
              <Button asChild className="px-4">
                <Link href={cmsSectionHref("overview")}>
                  <GlobeIcon className="size-4" />
                  مدیریت سایت
                </Link>
              </Button>
            ) : (
              <Button asChild className="px-4">
                <Link href={cmsSectionHref("setup")}>
                  <WandSparklesIcon className="size-4" />
                  {built > 0 ? "ادامهٔ ساخت سایت" : "ساخت سایت"}
                </Link>
              </Button>
            )}
            <Button asChild variant="outline" className="px-4">
              <Link href={cmsSectionHref("billing")}>اشتراک و صورت‌حساب</Link>
            </Button>
          </div>
        </SectionCard>

        <SectionCard
          title="وردپرس و ووکامرس"
          description="سایت وردپرسی که خودتان دارید: محصولات، سفارش‌ها، مشتریان، دسته‌بندی‌ها، محتوا و رسانه‌ها."
          actions={
            <StatusBadge tone={managers?.wp.connected ? "positive" : "neutral"}>
              {managers?.wp.connected ? "متصل" : "وصل نشده"}
            </StatusBadge>
          }
        >
          <p className="text-sm leading-6 text-muted-foreground">
            {managers?.wp.connected
              ? `${toPersianDigits(managers.wp.storeCount)} فروشگاه به این حساب وصل است.`
              : "با افزونهٔ وردپرس یا کلیدهای REST ووکامرس وصل می‌شود."}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {managers?.wp.connected ? (
              <Button asChild className="px-4">
                <Link href={wpSectionHref("overview")}>
                  <GlobeIcon className="size-4" />
                  مدیریت فروشگاه
                </Link>
              </Button>
            ) : (
              <Button asChild className="px-4">
                <Link href="/settings/connections?tab=woocommerce">
                  <PlugZapIcon className="size-4" />
                  اتصال فروشگاه وردپرسی
                </Link>
              </Button>
            )}
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="این دو با هم چه فرقی دارند؟"
        description="هر دو یک کار می‌کنند — داشتن سایت — ولی از دو راه، و هرکدام جدا مدیریت می‌شود."
      >
        <ul className="space-y-2 text-sm leading-6 text-muted-foreground">
          <li>
            <span className="font-medium text-foreground">سایت‌ساز اشوبه:</span> سایت را پلتفرم می‌سازد و
            نگه می‌دارد؛ دامنه، CDN و هزینهٔ ماهانه هم از همین‌جا مدیریت و پرداخت می‌شود.
          </li>
          <li>
            <span className="font-medium text-foreground">وردپرس و ووکامرس:</span> سایت مال خودتان است و
            جای دیگری میزبانی می‌شود؛ این‌جا فقط آن را مدیریت و با صندوق هماهنگ می‌کنید.
          </li>
          <li>
            در هر دو حالت، قیمت و موجودی یک‌طرفه از صندوق به سایت می‌رود — سایت ویترین است، منبع حقیقت
            همین‌جاست.
          </li>
        </ul>
      </SectionCard>
    </PageShell>
  );
}
