import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { effectiveFeatures } from "@/lib/features";
import { AskAssistant } from "@/components/ai/ask-assistant";
import { PageHeader, PageShell } from "../page-chrome";
import { GrowthManager } from "./growth-manager";
import { GROWTH_SECTION_KEYS, type GrowthSectionKey } from "./growth-sections";

/**
 * The Growth & Marketing app (Phase 36b).
 *
 * Loyalty, campaigns and gift cards, and seller commission used to be three
 * flat sidebar pages that each happened to post to the ledger. This is their
 * app: one home with a management dashboard of its own — the same shape the
 * accounting suite has (`/dashboard/ledger`), over the same services and the
 * same posting rules, nothing rewritten.
 *
 * Roles: the app's own sections restrict themselves (the manager drops the
 * commission and dashboard sections for a cashier, the way the ledger drops
 * payroll for a manager) — the page itself only refuses the roles that have
 * no business in any growth surface.
 */
export default async function GrowthPage({
  searchParams,
}: {
  searchParams: Promise<{ section?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  const [{ section }, features] = await Promise.all([searchParams, effectiveFeatures(session.businessId)]);
  const initialSection: GrowthSectionKey = GROWTH_SECTION_KEYS.includes(section as GrowthSectionKey)
    ? (section as GrowthSectionKey)
    : // A cashier cannot see the dashboard section; send them straight to the
      // one surface that is theirs, exactly as the old /dashboard/loyalty did.
      session.role === "cashier"
        ? "loyalty"
        : "overview";

  return (
    <PageShell>
      <PageHeader
        title="رشد و بازاریابی"
        description="یک برنامه برای نگه‌داشتن و رشد مشتریان: میز کار، کمپین‌ها و کارت هدیه، وفاداری و پورسانت فروشندگان — هر عددش همان جایی در حسابداری می‌نشیند که همیشه می‌نشست."
        actions={
          features.ai_assistant ? (
            <AskAssistant
              app="growth"
              context="وضعیت بازاریابی را بررسی کن: کمپین‌های فعال، تخفیف مصرفی سی روز گذشته، مانده کارت هدیه و اعتبار فروشگاهی، و پورسانت فروشندگان."
            />
          ) : null
        }
      />
      <GrowthManager role={session.role} initialSection={initialSection} />
    </PageShell>
  );
}
