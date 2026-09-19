import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { buildDraftTestBytes } from "@/lib/printing/render-service";

/**
 * The add-printer wizard's «چاپ آزمایشی» for a printer that is not saved
 * yet: the server renders the canonical sample document for the chosen roll
 * width, the browser delivers it locally to the target the operator picked.
 * No hardware address is sent here — rendering never needs one — and only
 * settings-managing roles may ask for it.
 */
export const runtime = "nodejs";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { kind?: unknown; paperWidthMm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind === "kitchen" ? "kitchen" : body.kind === "receipt" ? "receipt" : null;
  const paperWidthMm = Number(body.paperWidthMm);
  if (!kind || (paperWidthMm !== 58 && paperWidthMm !== 80)) {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  try {
    const bytes = await buildDraftTestBytes(kind, paperWidthMm);
    return NextResponse.json({ ok: true, dataBase64: Buffer.from(bytes).toString("base64") });
  } catch (err) {
    console.error("draft test render failed", err);
    return NextResponse.json({ ok: false, error: "render_failed" }, { status: 502 });
  }
});
