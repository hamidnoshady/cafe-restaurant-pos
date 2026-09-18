import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { query } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { resolveActiveLocation } from "@/lib/setup-state";
import { getSetting, setSetting, SETTING_KEYS } from "@/lib/settings";
import { BranchError, updateBranch } from "@/lib/branch-service";
import { normalizeBranchName } from "@/lib/branch-input";

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

  // The branch's own name/address/phone go through the same audited,
  // duplicate-checked, length-ruled `updateBranch` the branch screen uses.
  // This form used to write `locations.name` directly, so it could rename the
  // active branch to a name another branch already answers to (the exact
  // confusion branchNameTaken exists to prevent) and could store a name the
  // branch editor would then refuse to save — the two screens editing one
  // column disagreed about its rules.
  const normalizedLocationName = normalizeBranchName(locationName);
  const branchInput: {
    name?: string;
    address?: string | null;
    phone?: string | null;
  } = {};
  if (normalizedLocationName !== location.name) branchInput.name = normalizedLocationName;
  if ((address || null) !== location.address) branchInput.address = address || null;
  if ((phone || null) !== location.phone) branchInput.phone = phone || null;
  if (Object.keys(branchInput).length > 0) {
    try {
      await updateBranch({
        businessId: session.businessId,
        locationId: location.id,
        actorId: session.sub,
        ...branchInput,
      });
    } catch (err) {
      if (err instanceof BranchError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  }

  // Read the previous business identity before overwriting it, so the audit
  // row below can record what actually changed rather than a restatement.
  const { rows: beforeRows } = await query<{ name: string }>(
    "SELECT name FROM businesses WHERE id = $1",
    [session.businessId],
  );
  const beforeProfile = await getSetting<BusinessProfile>(
    session.businessId,
    SETTING_KEYS.businessProfile,
  );
  const beforePrefs = await getSetting<BusinessPrefs>(session.businessId, SETTING_KEYS.businessPrefs);
  const beforeName = beforeRows[0]?.name;

  await query("UPDATE businesses SET name = $1 WHERE id = $2", [businessName, session.businessId]);
  await Promise.all([
    setSetting(session.businessId, SETTING_KEYS.businessPrefs, prefs),
    setSetting(session.businessId, SETTING_KEYS.businessProfile, profile),
  ]);

  // The business's name, its tax identity and the unit every amount is shown
  // in are material enough to be reviewable: the branch screens audit their
  // equivalent edits, and this form was the one writer in the area with no
  // trail at all. Only the business-level fields are recorded here — the
  // branch fields above carry their own `branch.updated` row.
  const changed: Record<string, unknown> = {};
  if (businessName !== beforeName) changed.businessName = businessName;
  if (prefs.currencyDisplay !== beforePrefs?.currencyDisplay) {
    changed.currencyDisplay = prefs.currencyDisplay;
  }
  // Over the fixed key list rather than Object.entries(profile): a cleared
  // field is *absent* from the new profile, and entries() would skip it —
  // recording every change except the one that removed a value.
  for (const key of ["legalName", "taxId", "email", "website", "receiptFooter"] as const) {
    const value = profile[key];
    if (value !== beforeProfile?.[key]) changed[key] = value ?? null;
  }
  if (Object.keys(changed).length > 0) {
    await query(
      `INSERT INTO audit_log (business_id, location_id, user_id, action, entity, entity_id, payload)
       VALUES ($1, $2, $3, 'settings.business.update', 'settings', 'business', $4)`,
      [session.businessId, location.id, session.sub, JSON.stringify(changed)],
    );
  }

  return NextResponse.json({ ok: true });
});
