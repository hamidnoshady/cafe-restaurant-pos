import { NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { getInventoryOverview } from "@/lib/inventory-service";

/** Read-only inventory overview for the API key's one branch. */
export const GET = withApiKeyScope(async (apiKey) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.inventoryRead);
  if (denied) return denied;

  return NextResponse.json(await getInventoryOverview(apiKey.locationId, apiKey.businessId));
});
