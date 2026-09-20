import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { clientVersionCompliance } from "@/lib/platform-service";

/**
 * Read-only cross-business release-version visibility. Automatic update
 * distribution is intentionally absent until signing, integrity verification,
 * pre-migration backup and rollback exist.
 */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;

  return NextResponse.json({ clients: await clientVersionCompliance() });
});
