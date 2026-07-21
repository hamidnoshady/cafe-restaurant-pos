import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { runRollupPush } from "@/lib/rollup-service";

/** "Sync now": one immediate push attempt, same code path as the timer tick. */
export async function POST() {
  const { session, error } = await requireRole("owner");
  if (error) return error;

  const result = await runRollupPush(session.businessId);
  return NextResponse.json({ result });
}
