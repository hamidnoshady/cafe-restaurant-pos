import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBusinessIndustry, requireModuleForPage } from "@/lib/industry-guard";
import { industryProfile } from "@/lib/industry-profile";
import { PosScreen } from "./pos-screen";
import { RetailInvoiceScreen } from "./retail-invoice-screen";

/**
 * The selling screen, whichever selling means here.
 *
 * One route and one nav entry for both, branching on the industry's
 * `salesModel` rather than on a named industry, so a fifth trade is a profile
 * entry rather than another `if` — and so role guards, the offline banner and
 * the print wiring stay in one place. F&B's screen is untouched.
 */
export default async function PosPage({
  searchParams,
}: {
  /**
   * `?table=<id>` starts the sale already seated at that table — how «مهمان جدید
   * روی این میز» on an order's detail sends a friend at a busy table to the till
   * for their own, separate bill.
   */
  searchParams: Promise<{ table?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  await requireModuleForPage(session.businessId, "pos");
  if (!["owner", "manager", "cashier"].includes(session.role)) redirect("/dashboard");

  const industry = (await getBusinessIndustry(session.businessId)) ?? "food_service";
  if (industryProfile(industry).salesModel === "retail_invoice") {
    return <RetailInvoiceScreen industry={industry} />;
  }
  const { table } = await searchParams;
  return <PosScreen initialTableId={table ?? null} />;
}
