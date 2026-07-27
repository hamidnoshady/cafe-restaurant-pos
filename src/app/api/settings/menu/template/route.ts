import { NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { SETTINGS_SAMPLE_CSV } from "@/lib/menu-import";
import { PERMISSIONS } from "@/lib/permissions";

export const GET = withTenantScope(async () => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;
  return new NextResponse(SETTINGS_SAMPLE_CSV, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="menu-settings-template.csv"',
    },
  });
});
