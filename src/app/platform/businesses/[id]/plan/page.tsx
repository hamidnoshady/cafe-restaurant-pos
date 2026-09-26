import { redirect } from "next/navigation";

/**
 * Retired route (migration 0176): a business's plan, limits and usage are part
 * of its consolidated commercial page now. `/platform/businesses/:id/plan` →
 * the subscription tab of the business billing page.
 */
export default async function BusinessPlanRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/platform/businesses/${encodeURIComponent(id)}/billing?tab=subscription`);
}
