"use client";

/**
 * Growth → «تنظیمات رشد و بازاریابی» — the Growth app's *own* settings.
 *
 * Not the platform settings page and not a redirect to it: `/settings`
 * configures the business, `/growth/settings` configures campaigns, loyalty
 * and the messaging senders this app owns. Message credit is the one money
 * surface here, and it is platform-owned, so it is linked as platform billing
 * rather than reproduced inside the app.
 */

import { CreditCardIcon, HeartIcon, MegaphoneIcon, MessageCircleIcon } from "lucide-react";
import {
  AppSettingsPanel,
  type AppSettingsGroup,
} from "@/components/app-settings/app-settings-panel";
import { PLATFORM_BILLING_HREF, PLATFORM_SUBSCRIPTION_HREF } from "@/lib/app-routes";

const GROUPS: AppSettingsGroup[] = [
  {
    key: "loyalty",
    label: "قواعد وفاداری",
    description: "نرخ امتیازدهی، ارزش بازخرید و انقضای امتیازها.",
    icon: HeartIcon,
    comingSoon:
      "ویرایش قواعد وفاداری از همین صفحه به‌زودی اضافه می‌شود؛ فعلاً این قواعد در بخش «وفاداری و اعتبار» همین برنامه تنظیم می‌شود.",
  },
  {
    key: "campaigns",
    label: "پیش‌فرض‌های کمپین",
    description: "سقف تخفیف، بازهٔ پیش‌فرض کمپین‌ها و قواعد هم‌پوشانی.",
    icon: MegaphoneIcon,
    comingSoon: "پیش‌فرض‌های کمپین هنوز آماده نشده و به‌زودی در همین صفحه اضافه می‌شود.",
  },
  {
    key: "messaging",
    label: "پیام‌رسانی",
    description: "نام فرستنده، امضای پیام و قواعد رضایت ارتباط.",
    icon: MessageCircleIcon,
    comingSoon:
      "تنظیمات فرستنده و امضای پیام به‌زودی اضافه می‌شود؛ رضایت ارتباط هر مشتری در برنامهٔ «ارتباط با مشتری» نگهداری می‌شود.",
  },
  {
    key: "commission",
    label: "قواعد پورسانت",
    description: "پایهٔ محاسبه و دورهٔ تسویهٔ پورسانت فروشندگان.",
    icon: CreditCardIcon,
    comingSoon:
      "قواعد پورسانت فعلاً در بخش «پورسانت فروشندگان» همین برنامه مدیریت می‌شود؛ خلاصهٔ آن‌ها به‌زودی این‌جا می‌آید.",
  },
];

export function GrowthSettingsSection() {
  return (
    <AppSettingsPanel
      groups={GROUPS}
      platformNote="اعتبار پیامک و اشتراک، متعلق به پلتفرم است — نه به برنامهٔ رشد و بازاریابی."
      platformLinks={[
        {
          label: "اعتبار و صورت‌حساب پلتفرم",
          description: "شارژ اعتبار پیامک و تاریخچهٔ پرداخت، در تنظیمات پلتفرم.",
          href: PLATFORM_BILLING_HREF,
        },
        {
          label: "اشتراک پلتفرم",
          description: "پلن فعلی کسب‌وکار، در تنظیمات پلتفرم.",
          href: PLATFORM_SUBSCRIPTION_HREF,
        },
      ]}
    />
  );
}
