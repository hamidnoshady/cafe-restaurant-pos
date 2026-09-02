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

const MAX_NAME = 200;
const MAX_ADDRESS = 500;
const MAX_PHONE = 32;
const MAX_TAX_ID = 50;
const MAX_WEBSITE = 300;
const MAX_RECEIPT_FOOTER = 500;

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
  const address = text(body.address);
  const phone = text(body.phone);
  const legalName = text(body.legalName);
  const taxId = text(body.taxId);
  const website = text(body.website);
  const receiptFooter = text(body.receiptFooter);
  if (
    businessName.length > MAX_NAME ||
    locationName.length > MAX_NAME ||
    address.length > MAX_ADDRESS ||
    phone.length > MAX_PHONE ||
    legalName.length > MAX_NAME ||
    taxId.length > MAX_TAX_ID ||
    website.length > MAX_WEBSITE ||
    receiptFooter.length > MAX_RECEIPT_FOOTER
  ) {
    return NextResponse.json({ error: "field_too_long" }, { status: 400 });
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
    legalName: legalName || undefined,
    taxId: taxId || undefined,
    email: email || undefined,
    website: website || undefined,
    receiptFooter: receiptFooter || undefined,
  };

  await query("UPDATE businesses SET name = $1 WHERE id = $2", [businessName, session.businessId]);
  await query("UPDATE locations SET name = $1, address = $2, phone = $3 WHERE id = $4", [
    locationName,
    address || null,
    phone || null,
    location.id,
  ]);
  await Promise.all([
    setSetting(session.businessId, SETTING_KEYS.businessPrefs, prefs),
    setSetting(session.businessId, SETTING_KEYS.businessProfile, profile),
  ]);

  return NextResponse.json({ ok: true });
});
