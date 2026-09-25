import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { uploadWebsiteMedia, websiteStatusFor } from "@/lib/website/content-service";

/** Upload one featured image through the server; the CMS key never reaches the browser. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.cmsContentManage);
  if (error) return error;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });
  const result = await uploadWebsiteMedia({
    businessId: session.businessId,
    filename: file.name,
    mimeType: file.type,
    bytes: new Uint8Array(await file.arrayBuffer()),
    alt: typeof form?.get("alt") === "string" ? String(form.get("alt")) : undefined,
  });
  if (!result.ok) {
    const status = result.error === "invalid_media" ? 400 : websiteStatusFor(result.error);
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ media: result.data }, { status: 201 });
});
