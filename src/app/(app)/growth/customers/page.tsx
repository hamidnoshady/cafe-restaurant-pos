import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { GrowthSection } from "../growth-section";
import { canViewGrowthSection, growthFallbackHref } from "../growth-routes";

/**
 * Growth's own customers screen — its lifecycle/purchase columns, managed here
 * on the shared record.
 *
 * `?customer=<id>` opens one record straight away — the spelling the CRM
 * directory and the Accounting A/R rows already use, and the one this screen's
 * own comment says its deep links arrive with. It only read `?customerId=`
 * before, so every real link into it was silently ignored and the record never
 * opened. `customerId` is still accepted, because the deleted
 * `growthCustomerHref()` produced it and a bookmark should not break.
 */
export default async function GrowthCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; customerId?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");
  if (!canViewGrowthSection(session.role, "customers")) redirect(growthFallbackHref(session.role));

  const { customer, customerId } = await searchParams;
  return (
    <GrowthSection
      section="customers"
      role={session.role}
      selectedCustomerId={customer ?? customerId}
    />
  );
}
