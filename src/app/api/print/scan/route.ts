import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { scanLanPrinters } from "@/lib/system-print/service";

/**
 * Sweep the app server's local network for ESC/POS printers on the raw-print
 * ports — the server-side twin of the agent's POST /printers/scan, used when
 * no local agent answers on loopback. On an on-prem deployment the server
 * sits on the same LAN as the printers, so the sweep finds the same boxes the
 * agent would have.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // no body — sweep the server's own subnets with the defaults
  }

  const printers = await scanLanPrinters({
    subnets: Array.isArray(body.subnets) ? (body.subnets as string[]).slice(0, 4) : undefined,
    ports: Array.isArray(body.ports) ? (body.ports as number[]).slice(0, 4) : undefined,
    // Clamped: this runs inside a request, and a patient sweep is the agent's job.
    timeoutMs: typeof body.timeoutMs === "number" ? Math.min(Math.max(body.timeoutMs, 100), 1000) : undefined,
  });
  return NextResponse.json({ ok: true, printers });
});
