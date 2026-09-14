import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { listSystemPrinters } from "@/lib/system-print/service";

/**
 * The print queues installed on the machine the APP SERVER runs on — the
 * server-side twin of the agent's GET /printers/system. On the deployment
 * shapes where the server is the till machine itself (Electron shell, an
 * on-prem box), this is exactly the Windows «Printers & scanners» list the
 * person pairing hardware is looking at; the browser's print client falls
 * back to this when no local agent answers on loopback.
 */
export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  return NextResponse.json({ ok: true, printers: await listSystemPrinters() });
});
