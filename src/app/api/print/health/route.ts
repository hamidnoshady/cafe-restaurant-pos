import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";

/**
 * "Can this deployment print server-side?" — the app-server twin of the local
 * print agent's GET /health. The browser's print client (print-agent-client.ts)
 * asks the loopback agent first and falls back to this; a deployment where the
 * app server runs on the same machine/LAN as the printers (Electron shell,
 * Docker on the till laptop, an on-prem server) can print without anyone
 * installing or starting the separate agent.
 */
export const GET = withTenantScope(async () => {
  const { error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;
  return NextResponse.json({ ok: true, platform: process.platform, version: 2, source: "server" });
});
