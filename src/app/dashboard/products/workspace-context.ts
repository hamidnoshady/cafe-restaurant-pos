import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { getBusinessIndustry } from "@/lib/industry-guard";
import {
  isProductWorkspaceIndustry,
  productApiBaseFor,
  type ProductWorkspaceIndustry,
} from "@/lib/product-workspace";

/**
 * The shared server-side door of every products-workspace page: session,
 * owner/manager role and the trade-goods industry set, then the trade's own
 * items/stock API prefix. `draftScope` keeps local add-product drafts isolated
 * by business and branch on shared devices.
 */
export async function requireProductWorkspace(): Promise<{
  industry: ProductWorkspaceIndustry;
  apiBase: string;
  draftScope: string;
}> {
  const session = await getSession();
  if (!session) redirect("/login");
  const access = await memberAccessFor(session);
  if (!access?.permissions.has("inventory.view")) redirect("/accounting/overview");
  const industry = await getBusinessIndustry(session.businessId);
  if (!isProductWorkspaceIndustry(industry)) redirect("/accounting/overview");
  const draftLocation = session.activeLocationId ?? session.locationId ?? "default-location";
  return {
    industry,
    apiBase: productApiBaseFor(industry),
    draftScope: `${session.businessId}:${draftLocation}`,
  };
}
