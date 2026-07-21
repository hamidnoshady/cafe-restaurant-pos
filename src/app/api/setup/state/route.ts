import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { computeSetupState, hasAnyUser } from "@/lib/setup-state";

/**
 * Aggregated wizard state. Public only to the extent of answering
 * "does this install need bootstrapping?" — everything else requires
 * an Owner/Manager session.
 */
export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ needsBootstrap: !(await hasAnyUser()) });
  }
  if (session.role !== "owner" && session.role !== "manager") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const state = await computeSetupState(session.businessId);
  return NextResponse.json(state);
}
