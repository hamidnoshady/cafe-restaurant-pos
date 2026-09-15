import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { preferredProto, requestHost } from "@/lib/host";
import { PERMISSIONS } from "@/lib/permissions";
import { buildWindowsPrintConnectorInstaller } from "@/lib/windows-print-connector";

export const runtime = "nodejs";

/**
 * Authenticated, tenant-origin-specific one-click installer.
 *
 * The executable-looking download is a Windows command file containing only
 * built-in PowerShell setup code. It downloads the public connector source,
 * installs it per-user, starts it, and creates a Startup shortcut. Baking this
 * request's origin into the installer lets the loopback listener enforce exact
 * CORS instead of becoming a localhost printing endpoint for arbitrary sites.
 */
export const GET = withTenantScope(async (request: NextRequest) => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const host = requestHost(request.headers);
  if (!host) {
    return NextResponse.json({ ok: false, error: "installer_origin_unavailable" }, { status: 400 });
  }

  try {
    const protocol = preferredProto(request.headers.get("x-forwarded-proto"), request.nextUrl.protocol);
    const origin = new URL(`${protocol}://${host}`).origin;
    const installer = buildWindowsPrintConnectorInstaller(origin);
    return new NextResponse(installer, {
      status: 200,
      headers: {
        "Content-Type": "application/x-msdownload; charset=utf-8",
        "Content-Disposition": 'attachment; filename="Install-Cafe-POS-Print-Connector.cmd"',
        "Cache-Control": "private, no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: "installer_origin_invalid" }, { status: 400 });
  }
});
