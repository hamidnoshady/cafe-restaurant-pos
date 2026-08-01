import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  getAiProactiveOverview,
  setAiProactiveEnabled,
} from "@/lib/ai-proactive-service";
import { requireManager } from "@/lib/setup-state";

/** Manager-controlled opt-in for credit-consuming background AI work. */
export const GET = withTenantScope(async () => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  return NextResponse.json(await getAiProactiveOverview(guard.session.businessId));
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const guard = await requireManager();
  if (guard.error) return guard.error;
  let body: { enabled?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "invalid_proactive_enabled" }, { status: 400 });
  }
  const settings = await setAiProactiveEnabled(guard.session.businessId, body.enabled);
  return NextResponse.json({ enabled: settings.enabled });
});
