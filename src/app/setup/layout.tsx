import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import { industryProfile, labelFor } from "@/lib/industry-profile";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import { MoneyProvider } from "@/components/money/money-context";
import { StepNav } from "./step-nav";
import { SetupAssistant } from "./setup-assistant";
import { SetupIndustryProvider } from "./industry-context";
import { isSetupComplete } from "@/lib/setup-state";

export default async function SetupLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  if (await isSetupComplete(session.businessId)) redirect("/dashboard/settings");
  const industry = (await getBusinessIndustry(session.businessId)) ?? "food_service";
  const prefs = await getSetting<{ currencyDisplay?: "toman" | "rial" }>(
    session.businessId,
    SETTING_KEYS.businessPrefs,
  );
  const currencyDisplay = prefs?.currencyDisplay === "rial" ? "rial" : "toman";

  return (
    <SetupIndustryProvider industry={industry}>
      <MoneyProvider unit={currencyDisplay}>
      <div className="mx-auto flex min-h-screen max-w-5xl gap-6 p-4 sm:p-6">
        <aside className="hidden w-60 shrink-0 sm:block">
          <div className="sticky top-6 rounded-2xl bg-card p-4 shadow-sm">
            <p className="mb-1 font-bold">راه‌اندازی اولیه</p>
            {/*
              Which trade this business is registered as -- it decides the step
              list, the chart of accounts and the wording of every step, so an
              owner who was provisioned as the wrong industry should be able to
              see that here rather than infer it from a café example three
              steps in. Changing it is a super-admin action in the platform
              console, not something the wizard can offer.
            */}
            <p className="text-xs font-medium text-foreground/80">
              {industryProfile(industry).brandTitle}
            </p>
            <p className="mb-4 text-xs text-muted-foreground">
              گام‌به‌گام تا آماده‌شدن برای ثبت {labelFor(industry, "saleDocument")}
            </p>
            <StepNav />
          </div>
        </aside>
          <main className="min-w-0 flex-1 rounded-2xl bg-card p-6 shadow-sm">{children}</main>
          <SetupAssistant />
        </div>
      </MoneyProvider>
    </SetupIndustryProvider>
  );
}
