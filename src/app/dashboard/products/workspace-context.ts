import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { getBusinessIndustry } from "@/lib/industry-guard";
import {
  isProductWorkspaceIndustry,
  productApiBaseFor,
  type ProductWorkspaceIndustry,
} from "@/lib/product-workspace";

/**
 * The shared server-side door of every products-workspace page: session,
 * owner/manager role and the trade-goods industry set, then the trade's own
 * items/stock API prefix the client sections write through.
 */
export async function requireProductWorkspace(): Promise<{
  industry: ProductWorkspaceIndustry;
  apiBase: string;
}> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (session.role !== "owner" && session.role !== "manager") redirect("/dashboard");
  const industry = await getBusinessIndustry(session.businessId);
  if (!isProductWorkspaceIndustry(industry)) redirect("/dashboard");
  return { industry, apiBase: productApiBaseFor(industry) };
}
