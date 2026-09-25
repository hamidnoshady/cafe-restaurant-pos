import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile, labelFor } from "@/lib/industry-profile";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { MoneyProvider } from "@/components/money/money-context";
import { cardClass } from "@/app/dashboard/page-chrome";
import { StepNav } from "./step-nav";
import { SetupIndustryProvider } from "./industry-context";
import { isSetupComplete } from "@/lib/setup-state";
import { Building2Icon, ShieldCheckIcon, SparklesIcon } from "lucide-react";

export default async function SetupLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  if (!access?.permissions.has("settings.manage")) redirect("/dashboard");
  // The platform settings area's canonical address. `/dashboard/settings`
  // still 308s here, but a redirect the app issues itself should land on the
  // real URL rather than spend a hop.
  if (await isSetupComplete(session.businessId)) redirect("/settings");
  const industry =
    (await getBusinessIndustry(session.businessId)) ?? "food_service";
  const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
    session.businessId,
    SETTING_KEYS.businessPrefs,
  );
  const currencyDisplay = prefs?.currencyDisplay === "rial" ? "rial" : "toman";
  const profile = industryProfile(industry);

  return (
    <SetupIndustryProvider industry={industry}>
      <MoneyProvider unit={currencyDisplay}>
        <div className="min-h-screen bg-background">
          <header className="border-b border-border bg-card">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                  <SparklesIcon className="size-5" aria-hidden="true" />
                </div>
                <div>
                  <p className="font-bold text-foreground">
                    راه‌اندازی فضای کار
                  </p>
                  <p className="text-xs text-muted-foreground">
                    تغییرات هر مرحله پس از ذخیره باقی می‌ماند
                  </p>
                </div>
              </div>
              <div className="hidden items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground sm:flex">
                <ShieldCheckIcon className="size-4 text-emerald-700 dark:text-emerald-300" />
                راه‌اندازی امن
              </div>
            </div>
          </header>

          <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
            <section
              className={`mb-4 p-3 sm:hidden ${cardClass}`}
              aria-label="مراحل راه‌اندازی"
            >
              <StepNav compact />
            </section>
            <div className="flex items-start gap-6">
              <aside className="sticky top-6 hidden w-64 shrink-0 sm:block">
                <div className={`${cardClass} overflow-hidden`}>
                  <div className="border-b border-border bg-muted/60 p-5">
                    <div className="mb-3 flex size-10 items-center justify-center rounded-2xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                      <Building2Icon className="size-5" />
                    </div>
                    <p className="text-xs font-semibold text-amber-700 dark:text-amber-300">
                      نوع کسب‌وکار
                    </p>
                    <p className="mt-1 font-bold text-foreground">
                      {profile.brandTitle}
                    </p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      گام‌به‌گام تا آماده‌شدن برای ثبت{" "}
                      {labelFor(industry, "saleDocument")}
                    </p>
                  </div>
                  <div className="p-3">
                    <StepNav />
                  </div>
                </div>
              </aside>
              <main className={`min-w-0 flex-1 p-5 sm:p-8 ${cardClass}`}>
                {children}
              </main>
            </div>
          </div>
        </div>
      </MoneyProvider>
    </SetupIndustryProvider>
  );
}
