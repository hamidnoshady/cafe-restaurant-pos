/**
 * Server-side cart resolution shared by "create order" and "add item to an
 * open order": looks up menu items + modifiers by id, prices from the DB
 * (never the client), and validates modifier group min/max select.
 */
import { query } from "./db";
import type { CartLine } from "./orders";

export interface CartItemInput {
  menuItemId?: string;
  quantity?: number;
  modifierIds?: string[];
  note?: string;
}

export interface PreparedItem {
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  note: string | null;
  modifiers: { id: string; name: string; priceDelta: number }[];
}

export type ResolveCartResult =
  | { ok: true; cartLines: CartLine[]; preparedItems: PreparedItem[] }
  | { ok: false; error: string; status: number };

const MAX_QTY = 50;

export function validateItemShape(items: CartItemInput[]): string | null {
  if (items.length === 0) return "no_items";
  for (const it of items) {
    const qty = Number(it.quantity);
    if (!it.menuItemId || !Number.isInteger(qty) || qty <= 0 || qty > MAX_QTY) {
      return "invalid_item";
    }
  }
  return null;
}

export async function resolveCartItems(locationId: string, items: CartItemInput[]): Promise<ResolveCartResult> {
  const menuItemIds = [...new Set(items.map((i) => i.menuItemId!))];
  const { rows: menuItems } = await query<{
    id: string;
    name: string;
    price: string;
    is_active: boolean;
    tax_rate: string;
  }>(
    `SELECT mi.id, mi.name, mi.price, mi.is_active, COALESCE(mc.tax_rate, 0) AS tax_rate
       FROM menu_items mi LEFT JOIN menu_categories mc ON mc.id = mi.category_id
      WHERE mi.location_id = $1 AND mi.id = ANY($2::uuid[])`,
    [locationId, menuItemIds],
  );
  const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));
  for (const id of menuItemIds) {
    const mi = menuItemMap.get(id);
    if (!mi || !mi.is_active) return { ok: false, error: "item_not_found", status: 404 };
  }

  const modifierIds = [...new Set(items.flatMap((i) => i.modifierIds ?? []))];
  const modifierMap = new Map<
    string,
    { id: string; group_id: string; name: string; price_delta: string; is_active: boolean }
  >();
  const allowedGroupsByItem = new Map<string, Set<string>>();
  if (modifierIds.length > 0) {
    const { rows: modifiers } = await query<{
      id: string;
      group_id: string;
      name: string;
      price_delta: string;
      is_active: boolean;
    }>(
      "SELECT id, group_id, name, price_delta, is_active FROM modifiers WHERE location_id = $1 AND id = ANY($2::uuid[])",
      [locationId, modifierIds],
    );
    for (const m of modifiers) modifierMap.set(m.id, m);

    const { rows: links } = await query<{ menu_item_id: string; modifier_group_id: string }>(
      "SELECT menu_item_id, modifier_group_id FROM menu_item_modifier_groups WHERE menu_item_id = ANY($1::uuid[])",
      [menuItemIds],
    );
    for (const l of links) {
      if (!allowedGroupsByItem.has(l.menu_item_id)) allowedGroupsByItem.set(l.menu_item_id, new Set());
      allowedGroupsByItem.get(l.menu_item_id)!.add(l.modifier_group_id);
    }
  }

  const { rows: groups } = await query<{ id: string; min_select: number; max_select: number }>(
    "SELECT id, min_select, max_select FROM modifier_groups WHERE location_id = $1",
    [locationId],
  );
  const groupMap = new Map(groups.map((g) => [g.id, g]));

  const cartLines: CartLine[] = [];
  const preparedItems: PreparedItem[] = [];

  for (const it of items) {
    const mi = menuItemMap.get(it.menuItemId!)!;
    const quantity = Number(it.quantity);
    const modifierIdsForItem = it.modifierIds ?? [];
    const allowedGroups = allowedGroupsByItem.get(it.menuItemId!) ?? new Set<string>();
    const selectedByGroup = new Map<string, number>();
    const modifiers: { id: string; name: string; priceDelta: number }[] = [];

    for (const modId of modifierIdsForItem) {
      const mod = modifierMap.get(modId);
      if (!mod || !mod.is_active || !allowedGroups.has(mod.group_id)) {
        return { ok: false, error: "invalid_modifier", status: 400 };
      }
      selectedByGroup.set(mod.group_id, (selectedByGroup.get(mod.group_id) ?? 0) + 1);
      modifiers.push({ id: mod.id, name: mod.name, priceDelta: Number(mod.price_delta) });
    }
    for (const groupId of allowedGroups) {
      const group = groupMap.get(groupId);
      if (!group) continue;
      const n = selectedByGroup.get(groupId) ?? 0;
      if (n < group.min_select || n > group.max_select) {
        return { ok: false, error: "invalid_modifier_selection", status: 400 };
      }
    }

    cartLines.push({
      unitPrice: Number(mi.price),
      quantity,
      modifierDeltas: modifiers.map((m) => m.priceDelta),
      taxRatePercent: Number(mi.tax_rate),
    });
    preparedItems.push({
      menuItemId: mi.id,
      name: mi.name,
      unitPrice: Number(mi.price),
      quantity,
      note: it.note?.trim() || null,
      modifiers,
    });
  }

  return { ok: true, cartLines, preparedItems };
}
