import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { analyseImport, commitImport } from "@/lib/crm-import-service";

/**
 * Bulk customer import.
 *
 * Two modes on one route, chosen by `commit`:
 *
 * - `commit: false` (or absent) — analyse only. Returns exactly what would
 *   happen, having written nothing.
 * - `commit: true` — perform it.
 *
 * The client is expected to call the first, show the result, and only call the
 * second after the user confirms. Nothing here trusts a plan computed
 * elsewhere: `commitImport` re-analyses the file server-side, because the
 * approved preview is minutes old and another member may have created a
 * matching customer in the meantime.
 *
 * Behind `crm.export` as well as `crm.manage` — the import permission pair is
 * deliberately the bulk-data one. Someone who can add a customer one at a time
 * is not thereby entitled to add nine thousand.
 */
const MAX_BYTES = 8 * 1024 * 1024;

export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.crmExport);
  if (error) return error;

  let body: { csv?: unknown; commit?: unknown; updateExisting?: unknown; source?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const csv = typeof body.csv === "string" ? body.csv : "";
  if (!csv.trim()) {
    return NextResponse.json({ error: "bad_request", message: "فایل خالی است" }, { status: 400 });
  }
  // Byte length, not character count: a Persian CSV is roughly two bytes per
  // character, so a character limit would reject a file half the size it
  // appears to allow.
  if (Buffer.byteLength(csv, "utf8") > MAX_BYTES) {
    return NextResponse.json(
      { error: "too_large", message: "فایل بیش از حد بزرگ است" },
      { status: 413 },
    );
  }

  if (body.commit !== true) {
    const analysis = await analyseImport(session.businessId, csv);
    if ("error" in analysis) {
      return NextResponse.json({ error: analysis.error }, { status: 400 });
    }
    return NextResponse.json({ analysis });
  }

  const result = await commitImport(
    session.businessId,
    csv,
    { name: session.fullName, userId: session.sub },
    {
      updateExisting: body.updateExisting === true,
      defaultSource: typeof body.source === "string" ? body.source : undefined,
    },
  );
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ result });
});
