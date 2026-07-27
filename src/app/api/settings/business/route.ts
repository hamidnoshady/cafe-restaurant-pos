import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";

interface BusinessPrefs {
  currencyDisplay: "toman" | "rial";
  language: "fa";
  calendar: "jalali";
}

interface BusinessProfile {
  legalName?: string;
  taxId?: string;
  email?: string;
  website?: string;
  receiptFooter?: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Operational business settings. Unlike /api/setup/business this never advances the wizard. */
export const GET = withTenantScope(async () => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const [{ rows }, prefs, profile] = await Promise.all([
    query<{ name: string }>("SELECT name FROM businesses WHERE id = $1", [session.businessId]),
    getSetting<BusinessPrefs>(session.businessId, SETTING_KEYS.businessPrefs),
    getSetting<BusinessProfile>(session.businessId, SETTING_KEYS.businessProfile),
  ]);
  return NextResponse.json({
    business: rows[0] ?? null,
    location: { name: location.name, address: location.address, phone: location.phone },
    prefs,
    profile,
  });
});

export const PUT = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const businessName = text(body.businessName);
  const locationName = text(body.locationName);
  if (!businessName || !locationName) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const email = text(body.email);
  if (email && !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const prefs: BusinessPrefs = {
    currencyDisplay: body.currencyDisplay === "rial" ? "rial" : "toman",
    language: "fa",
    calendar: "jalali",
  };
  const profile: BusinessProfile = {
    legalName: text(body.legalName) || undefined,
    taxId: text(body.taxId) || undefined,
    email: email || undefined,
    website: text(body.website) || undefined,
    receiptFooter: text(body.receiptFooter) || undefined,
  };

  await query("UPDATE businesses SET name = $1 WHERE id = $2", [businessName, session.businessId]);
  await query("UPDATE locations SET name = $1, address = $2, phone = $3 WHERE id = $4", [
    locationName,
    text(body.address) || null,
    text(body.phone) || null,
    location.id,
  ]);
  await Promise.all([
    setSetting(session.businessId, SETTING_KEYS.businessPrefs, prefs),
    setSetting(session.businessId, SETTING_KEYS.businessProfile, profile),
  ]);

  return NextResponse.json({ ok: true });
});
