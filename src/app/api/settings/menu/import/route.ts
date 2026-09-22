import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { PERMISSIONS } from "@/lib/permissions";
import { getSetting, SETTING_KEYS } from "@/lib/settings";
import {
  parseMenuCsv,
  rowsToImport,
  type ImportMoneyUnit,
  type ImportResult,
} from "@/lib/menu-import";
import {
  applyMenuImport,
  menuImportConsistencyErrors,
} from "@/lib/menu-import-apply";
import { resolveActiveLocation } from "@/lib/setup-state";
import { xlsxToRows } from "@/lib/data-transfer/codecs";

const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface TaxSetting {
  defaultRate: number;
}

interface BusinessPrefs {
  currencyDisplay?: "toman" | "rial";
}

function preview(result: ImportResult) {
  const modifierGroups = new Set(
    result.items
      .map((item) => item.modifierGroup)
      .filter((name): name is string => Boolean(name)),
  ).size;
  // The same «نوع شیر» group is usually listed on every drink that offers it;
  // counting one entry per item made a 10-drink menu claim 10× the modifiers
  // the import actually writes. Count what apply() would create: one row per
  // distinct (group, name) pair.
  const modifierKeys = new Set<string>();
  for (const item of result.items)
    for (const modifier of item.modifiers ?? [])
      modifierKeys.add(`${item.modifierGroup}\u0000${modifier.name}`);
  return {
    items: result.items.length,
    categories: result.categories.length,
    modifierGroups,
    modifiers: modifierKeys.size,
    errors: result.errors,
  };
}

/**
 * How the parsed rows collide with what is already on this branch's menu.
 * Import is an *upsert*: a row whose (category, name) already exists has its
 * price/description/sku overwritten. That is the operation's most surprising
 * side, so the preview says how many rows merge versus create — the counts are
 * advisory (another import in between can shift them), which is why they are
 * not part of the apply-side validation.
 */
async function existingMatches(locationId: string, result: ImportResult) {
  if (result.items.length === 0) return null;
  const client = await getPool().connect();
  try {
    const { rows: categories } = await client.query<{ count: string; inactive: string }>(
      `SELECT COUNT(*)::text AS count,
              COUNT(*) FILTER (WHERE NOT is_active)::text AS inactive
         FROM menu_categories
        WHERE location_id = $1 AND name = ANY($2::text[])`,
      [locationId, result.categories],
    );
    const { rows: items } = await client.query<{ count: string }>(
      `SELECT COUNT(DISTINCT mi.id)::text AS count
         FROM menu_items mi
         JOIN menu_categories mc ON mc.id = mi.category_id AND mc.location_id = $1
         JOIN unnest($2::text[], $3::text[]) AS u(category, name)
           ON mc.name = u.category AND mi.name = u.name`,
      [
        locationId,
        result.items.map((item) => item.category),
        result.items.map((item) => item.name),
      ],
    );
    return {
      categories: Number(categories[0]?.count ?? 0),
      inactiveCategories: Number(categories[0]?.inactive ?? 0),
      items: Number(items[0]?.count ?? 0),
    };
  } finally {
    client.release();
  }
}

/** Full menu import for Settings. It supports preview and never marks a wizard step. */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(
    PERMISSIONS.settingsManage,
  );
  if (error) return error;
  const location = await resolveActiveLocation(session);
  if (!location)
    return NextResponse.json({ error: "no_location" }, { status: 409 });

  let file: File | null = null;
  let mode = "preview";
  try {
    const form = await request.formData();
    const candidate = form.get("file");
    if (candidate instanceof File) file = candidate;
    mode = form.get("mode") === "apply" ? "apply" : "preview";
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!file)
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  if (file.size > MAX_FILE_BYTES)
    return NextResponse.json({ error: "file_too_large" }, { status: 413 });

  let result: ImportResult;
  try {
    // Prices in the file are read in the business's own display unit, the same
    // unit every money input in the app uses. Reading a Rial business's file
    // as Toman would store every price 10× too high.
    const prefs = await getSetting<BusinessPrefs>(
      session.businessId,
      SETTING_KEYS.businessPrefs,
    );
    const unit: ImportMoneyUnit =
      prefs?.currencyDisplay === "rial" ? "rial" : "toman";
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx"))
      result = rowsToImport(await xlsxToRows(await file.arrayBuffer()), unit);
    else if (
      name.endsWith(".csv") ||
      name.endsWith(".txt") ||
      name.endsWith(".tsv")
    )
      result = parseMenuCsv(await file.text(), unit);
    else
      return NextResponse.json(
        { error: "unsupported_format" },
        { status: 400 },
      );
  } catch {
    return NextResponse.json({ error: "parse_failed" }, { status: 400 });
  }
  result.errors.push(...menuImportConsistencyErrors(result));
  if (result.items.length === 0) {
    return NextResponse.json(
      {
        error: "nothing_to_import",
        errors: result.errors.length
          ? result.errors
          : ["آیتمی برای ورود پیدا نشد."],
      },
      { status: 400 },
    );
  }
  if (mode === "preview") {
    // Advisory only: a failed lookup degrades the preview to counts alone
    // rather than failing the whole request.
    let matches: Awaited<ReturnType<typeof existingMatches>> = null;
    try {
      matches = await existingMatches(location.id, result);
    } catch {
      matches = null;
    }
    return NextResponse.json({ preview: { ...preview(result), matches } });
  }
  if (result.errors.length > 0)
    return NextResponse.json(
      { error: "invalid_import", errors: result.errors },
      { status: 400 },
    );

  const tax = await getSetting<TaxSetting>(
    session.businessId,
    SETTING_KEYS.tax,
  );

  // One shared, transactional upsert (menu-import-apply.ts) — the same write
  // path the onboarding wizard uses, so bulk fixes land identically from
  // either door.
  const counts = await applyMenuImport(location.id, result, tax?.defaultRate ?? 0);

  return NextResponse.json({
    ok: true,
    createdCategories: counts.createdCategories,
    createdItems: counts.createdItems,
    updatedItems: counts.updatedItems,
    createdGroups: counts.createdGroups,
    createdModifiers: counts.createdModifiers,
    reactivatedCategories: counts.reactivatedCategories,
  });
});
