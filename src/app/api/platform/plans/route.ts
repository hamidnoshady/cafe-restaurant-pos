import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { listPlans } from "@/lib/platform-service";

/** The global plan catalogue — what the console offers when assigning a business's plan. */
export const GET = withPlatformScope(async () => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  return NextResponse.json({ plans: await listPlans() });
});
