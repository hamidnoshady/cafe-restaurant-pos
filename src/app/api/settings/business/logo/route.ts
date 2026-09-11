import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  buildBusinessLogo,
  hasMatchingLogoSignature,
  isLogoMimeType,
  isStoredLogo,
  isValidLogo,
  type BusinessLogo,
} from "@/lib/business-logo";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";

/** The stored logo, or null before one is uploaded. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  const logo = await getSetting<BusinessLogo>(session.businessId, SETTING_KEYS.businessLogo);
  return NextResponse.json({ logo: isStoredLogo(logo) ? logo : null });
});

/** Upload/replace the logo. Multipart, because the source is a file picker. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "missing_file" }, { status: 400 });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!isValidLogo({ mimeType: file.type, byteLength: bytes.byteLength })) {
    return NextResponse.json({ error: "invalid_logo" }, { status: 400 });
  }
  if (!isLogoMimeType(file.type) || !hasMatchingLogoSignature(file.type, bytes)) {
    return NextResponse.json({ error: "invalid_logo" }, { status: 400 });
  }

  const logo = buildBusinessLogo({ mimeType: file.type, bytes });
  await setSetting(session.businessId, SETTING_KEYS.businessLogo, logo);
  return NextResponse.json({ logo }, { status: 201 });
});

/** Remove the logo; every template that shows a logo block simply skips it. */
export const DELETE = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  await setSetting(session.businessId, SETTING_KEYS.businessLogo, null);
  return NextResponse.json({ ok: true });
});
