import { NextResponse } from "next/server";
import { withApiKeyScope } from "@/lib/api-auth";
import { API_SCOPES, requireApiScope } from "@/lib/api-scopes";
import { getMenuTree } from "@/lib/menu-service";

/** Returns the full sellable menu tree for the key's one branch. */
export const GET = withApiKeyScope(async (apiKey) => {
  const denied = requireApiScope(apiKey.scopes, API_SCOPES.menuRead);
  if (denied) return denied;

  return NextResponse.json(await getMenuTree(apiKey.locationId));
});
