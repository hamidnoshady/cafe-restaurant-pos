import { NextRequest, NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";
import { isValidPrinterConnection, type PrinterConnection } from "@/lib/printer-connection";
import { probeConnection } from "@/lib/system-print/service";

/** Is this printer answering right now, as seen from the app server? The server-side twin of the agent's POST /printers/probe. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { error } = await requireRole("owner", "manager", "cashier", "waiter", "kitchen");
  if (error) return error;

  let body: { connection?: PrinterConnection };
  try {
    body = (await request.json()) as { connection?: PrinterConnection };
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  if (!body.connection || !isValidPrinterConnection(body.connection)) {
    return NextResponse.json({ ok: false, error: "invalid_connection" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, ...(await probeConnection(body.connection)) });
});
