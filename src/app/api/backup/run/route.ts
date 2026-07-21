import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { runBackupNow } from "@/lib/backup-service";

/**
 * "Backup now": one immediate local backup (+ cloud upload when enabled),
 * the same code path as the scheduler tick. Owner/Manager — the manual
 * trigger is deliberately wider than config editing (Owner-only).
 */
export async function POST() {
  const { session, error } = await requireRole("owner", "manager");
  if (error) return error;

  const result = await runBackupNow(session.businessId);
  return NextResponse.json({ result });
}
