import { NextRequest, NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import {
  attachModifierGroupToItem,
  detachModifierGroupFromItem,
  updateItemModifierGroup,
} from "@/lib/menu-service";
import {
  validateItemModifierGroupAttach,
  validateItemModifierGroupPatch,
} from "@/lib/menu-validation";
import { resolveActiveLocation } from "@/lib/setup-state";

/**
 * Attach a modifier group to a menu item (optionally with per-item selection
 * bounds), re-configure an existing attachment, or detach one.
 *
 * A required group cannot be attached with fewer active options than its
 * resolved min — that would create an item no till can ever sell — and the
 * same rule guards every later re-configuration.
 */
export const POST = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const input = validateItemModifierGroupAttach(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await attachModifierGroupToItem(
    location.id,
    input.value.menuItemId,
    input.value.modifierGroupId,
    {
      minSelectOverride: input.value.minSelectOverride ?? null,
      maxSelectOverride: input.value.maxSelectOverride ?? null,
      sortOrder: input.value.sortOrder,
    },
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/** Re-configure one item's attachment: per-item bounds, order, on/off. */
export const PATCH = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const menuItemId = typeof body.menuItemId === "string" ? body.menuItemId : null;
  const modifierGroupId = typeof body.modifierGroupId === "string" ? body.modifierGroupId : null;
  if (!menuItemId || !modifierGroupId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const input = validateItemModifierGroupPatch(body);
  if (!input.ok) return NextResponse.json({ error: input.error }, { status: 400 });

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await updateItemModifierGroup(
    location.id,
    menuItemId,
    modifierGroupId,
    input.value,
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});

/** Detach a modifier group from a menu item. */
export const DELETE = withTenantScope(async (request: NextRequest) => {
  const { session, error } = await requirePermission(PERMISSIONS.menuEdit);
  if (error) return error;

  const menuItemId = request.nextUrl.searchParams.get("menuItemId");
  const modifierGroupId = request.nextUrl.searchParams.get("modifierGroupId");
  if (!menuItemId || !modifierGroupId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const location = await resolveActiveLocation(session);
  if (!location) return NextResponse.json({ error: "no_location" }, { status: 409 });

  const result = await detachModifierGroupFromItem(location.id, menuItemId, modifierGroupId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true });
});
