import { NextResponse } from "next/server";
import { requirePlatformAdmin, withPlatformScope } from "@/lib/platform-auth";
import { listInvoices } from "@/lib/subscription-service";

/**
 * The invoice ledger — every business's invoices, optionally filtered by
 * status. Line items ride along when `withLines=1` so the UI can expand one
 * invoice without a second endpoint.
 */
export const GET = withPlatformScope(async (req: Request) => {
  const { error } = await requirePlatformAdmin();
  if (error) return error;
  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  if (status && !["draft", "open", "paid", "partially_paid", "overdue", "void"].includes(status)) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const invoices = await listInvoices({
    status: status ?? undefined,
    limit: 200,
    withLines: url.searchParams.get("withLines") === "1",
  });
  return NextResponse.json({ invoices });
});
