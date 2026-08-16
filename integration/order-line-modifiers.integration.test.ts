/**
 * Re-picking the add-ons of a line that is already on an open order, against
 * a real database.
 *
 * Until now add-ons could only be chosen at the moment a line was created: a
 * guest who asked for bread after ordering had to have the line voided and
 * re-rung by hand. `updateOrderItem` does that for the till — and it must do
 * it by *superseding* the line, not by editing it, because
 * `order_item_inventory_snapshots` is immutable by trigger (migration 0013)
 * so that what a sale consumes cannot be rewritten behind the kitchen's back.
 *
 * What this pins down:
 *   1. the edited line is voided with a stated reason and a replacement line
 *      carries the new add-ons, at the price the guest was originally quoted;
 *   2. the order's totals follow the new add-on deltas;
 *   3. the replacement gets its own inventory snapshot and the superseded line
 *      is excluded from deduction — the stock consumed at payment matches the
 *      add-ons actually served, which is the whole point of the exercise;
 *   4. an add-on from a group the menu item does not carry is refused exactly
 *      as at intake, and nothing at all is written;
 *   5. leaving a required group unselected, or overrunning a group's
 *      max_select, is refused the same way;
 *   6. a closed order, and an already-voided line, refuse the edit outright;
 *   7. quantity and note ride along in the same transaction.
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/migrate";

const rootDatabaseUrl = process.env.DATABASE_URL;
if (!rootDatabaseUrl) {
  throw new Error("DATABASE_URL is required for database integration tests");
}

let databaseName: string;
let db: Client;
let dbLib: typeof import("../src/lib/db");
let orderMutations: typeof import("../src/lib/order-mutations");

function urlFor(database: string): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function maintenanceUrl(): string {
  const url = new URL(rootDatabaseUrl!);
  url.pathname = "/postgres";
  return url.toString();
}

interface Shop {
  businessId: string;
  locationId: string;
  menuItemId: string;
  /** «نان» +۳۰٬۰۰۰ تومان and «لیمو» +۱۰٬۰۰۰ تومان, from an optional 0..2 group. */
  breadId: string;
  lemonId: string;
  /** From a required 1..1 group on the same item. */
  smallId: string;
  largeId: string;
  /** Active and priced, but in a group this menu item does not carry. */
  foreignId: string;
  /** The inventory item «نان» consumes, for the snapshot assertions. */
  flourId: string;
}

/** One café whose bandari carries two add-on groups: optional extras, required size. */
async function createShop(): Promise<Shop> {
  const biz = await db.query<{ id: string }>(
    "INSERT INTO businesses (name, slug) VALUES ($1, $2) RETURNING id",
    [
      `AddOn Test ${randomUUID().slice(0, 6)}`,
      `addon-test-${randomUUID().slice(0, 8)}`,
    ],
  );
  const businessId = biz.rows[0].id;
  const loc = await db.query<{ id: string }>(
    "INSERT INTO locations (business_id, name) VALUES ($1, 'Main') RETURNING id",
    [businessId],
  );
  const locationId = loc.rows[0].id;
  const category = await db.query<{ id: string }>(
    "INSERT INTO menu_categories (location_id, name) VALUES ($1, 'غذا') RETURNING id",
    [locationId],
  );
  const item = await db.query<{ id: string }>(
    "INSERT INTO menu_items (location_id, category_id, name, price) VALUES ($1, $2, 'بندری', 3900000) RETURNING id",
    [locationId, category.rows[0].id],
  );
  const menuItemId = item.rows[0].id;

  const group = async (name: string, min: number, max: number) => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO modifier_groups (location_id, name, min_select, max_select) VALUES ($1, $2, $3, $4) RETURNING id",
      [locationId, name, min, max],
    );
    return rows[0].id;
  };
  const extrasId = await group("افزودنی‌ها", 0, 2);
  const sizeId = await group("اندازه", 1, 1);
  const sauceId = await group("سس", 0, 1);

  const modifier = async (groupId: string, name: string, delta: number) => {
    const { rows } = await db.query<{ id: string }>(
      "INSERT INTO modifiers (location_id, group_id, name, price_delta) VALUES ($1, $2, $3, $4) RETURNING id",
      [locationId, groupId, name, delta],
    );
    return rows[0].id;
  };
  const breadId = await modifier(extrasId, "نان", 300_000);
  const lemonId = await modifier(extrasId, "لیمو", 100_000);
  const smallId = await modifier(sizeId, "کوچک", 0);
  const largeId = await modifier(sizeId, "بزرگ", 400_000);
  const foreignId = await modifier(sauceId, "سس ویژه", 50_000);

  for (const groupId of [extrasId, sizeId]) {
    await db.query(
      "INSERT INTO menu_item_modifier_groups (menu_item_id, modifier_group_id) VALUES ($1, $2)",
      [menuItemId, groupId],
    );
  }

  // «نان» costs the kitchen flour; the dish itself has no recipe, so any
  // snapshot row on a line can only have come from that add-on.
  const flour = await db.query<{ id: string }>(
    "INSERT INTO inventory_items (location_id, name, unit) VALUES ($1, 'آرد', 'gram') RETURNING id",
    [locationId],
  );
  const flourId = flour.rows[0].id;
  await db.query(
    "INSERT INTO modifier_ingredients (modifier_id, inventory_item_id, quantity_delta) VALUES ($1, $2, 50)",
    [breadId, flourId],
  );

  return {
    businessId,
    locationId,
    menuItemId,
    breadId,
    lemonId,
    smallId,
    largeId,
    foreignId,
    flourId,
  };
}

/** An open order with one bandari on it, sized as asked. */
async function openOrder(shop: Shop, modifierIds: string[]) {
  const result = await dbLib.withTenant(shop.businessId, () =>
    orderMutations.createOrder({
      locationId: shop.locationId,
      type: "takeaway",
      discount: { type: null },
      items: [{ menuItemId: shop.menuItemId, quantity: 1, modifierIds }],
      openedBy: null,
    }),
  );
  if (!result.ok) throw new Error(`could not open order: ${result.error}`);
  const { rows } = await db.query<{ id: string }>(
    "SELECT id FROM order_items WHERE order_id = $1",
    [result.data.id],
  );
  return { orderId: result.data.id, orderItemId: rows[0].id };
}

function update(
  shop: Shop,
  orderId: string,
  orderItemId: string,
  patch: Record<string, unknown>,
) {
  return dbLib.withTenant(shop.businessId, () =>
    orderMutations.updateOrderItem({
      locationId: shop.locationId,
      orderId,
      orderItemId,
      ...patch,
    }),
  );
}

/** Compared as a set: the row order of a line's add-ons is not a promise the app makes. */
async function addOnNames(orderItemId: string): Promise<Set<string>> {
  const { rows } = await db.query<{ name_snapshot: string }>(
    "SELECT name_snapshot FROM order_item_modifiers WHERE order_item_id = $1",
    [orderItemId],
  );
  return new Set(rows.map((row) => row.name_snapshot));
}

async function lineStatus(orderItemId: string) {
  const { rows } = await db.query<{
    status: string;
    void_reason: string | null;
    quantity: number;
    note: string | null;
    unit_price: string;
  }>(
    "SELECT status, void_reason, quantity, note, unit_price FROM order_items WHERE id = $1",
    [orderItemId],
  );
  return rows[0];
}

/** Quantities as numbers — the column is numeric(24,9), so 50 reads back "50.000000000". */
async function snapshotQuantities(
  orderItemId: string,
): Promise<Record<string, number>> {
  const { rows } = await db.query<{
    inventory_item_id: string;
    required_quantity: string;
  }>(
    "SELECT inventory_item_id, required_quantity FROM order_item_inventory_snapshots WHERE order_item_id = $1",
    [orderItemId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.inventory_item_id, Number(row.required_quantity)]),
  );
}

/**
 * What the order will actually deduct at payment: the same join
 * inventory-service.ts uses, voided lines and all.
 */
async function pendingConsumption(
  orderId: string,
): Promise<Record<string, number>> {
  const { rows } = await db.query<{
    inventory_item_id: string;
    required_quantity: string;
  }>(
    `SELECT s.inventory_item_id, sum(s.required_quantity * oi.quantity)::text AS required_quantity
       FROM order_item_inventory_snapshots s JOIN order_items oi ON oi.id = s.order_item_id
      WHERE oi.order_id = $1 AND oi.status != 'voided' GROUP BY s.inventory_item_id`,
    [orderId],
  );
  return Object.fromEntries(
    rows.map((row) => [row.inventory_item_id, Number(row.required_quantity)]),
  );
}

async function orderTotal(orderId: string): Promise<number> {
  const { rows } = await db.query<{ total: string }>(
    "SELECT total FROM orders WHERE id = $1",
    [orderId],
  );
  return Number(rows[0].total);
}

async function liveLineCount(orderId: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    "SELECT count(*) FROM order_items WHERE order_id = $1 AND status != 'voided'",
    [orderId],
  );
  return Number(rows[0].count);
}

beforeAll(async () => {
  databaseName = `pos_addons_${randomUUID().replaceAll("-", "")}`;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  } finally {
    await maintenance.end();
  }

  await runMigrations({ databaseUrl: urlFor(databaseName), quiet: true });

  process.env.DATABASE_URL = urlFor(databaseName);
  dbLib = await import("../src/lib/db");
  orderMutations = await import("../src/lib/order-mutations");

  db = new Client({ connectionString: urlFor(databaseName) });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db?.end();
  await dbLib
    ?.getPool()
    .end()
    .catch(() => {});
  process.env.DATABASE_URL = rootDatabaseUrl;

  const maintenance = new Client({ connectionString: maintenanceUrl() });
  await maintenance.connect();
  try {
    await maintenance.query(
      `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    );
  } finally {
    await maintenance.end();
  }
});

describe("re-picking an open line's add-ons", () => {
  it("supersedes the line and re-prices the order", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);
    expect(await orderTotal(orderId)).toBe(3_900_000);

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId, shop.lemonId, shop.smallId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const replacementId = result.data.replacementItemId;
    expect(replacementId).toBeTruthy();

    expect(await lineStatus(orderItemId)).toMatchObject({
      status: "voided",
      void_reason: orderMutations.MODIFIERS_SUPERSEDED_REASON,
    });
    expect(await addOnNames(replacementId!)).toEqual(
      new Set(["نان", "لیمو", "کوچک"]),
    );
    // One live line, not two: the order still reads as one bandari.
    expect(await liveLineCount(orderId)).toBe(1);
    expect(await orderTotal(orderId)).toBe(3_900_000 + 300_000 + 100_000);
  });

  it("keeps the price the guest was quoted, not today's menu price", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);
    await db.query("UPDATE menu_items SET price = 9900000 WHERE id = $1", [
      shop.menuItemId,
    ]);

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId, shop.smallId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await lineStatus(result.data.replacementItemId!)).toMatchObject({
      unit_price: "3900000",
    });
    expect(await orderTotal(orderId)).toBe(3_900_000 + 300_000);
  });

  it("drops an add-on again, and its price with it", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [
      shop.breadId,
      shop.smallId,
    ]);
    expect(await orderTotal(orderId)).toBe(4_200_000);

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.smallId],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(await addOnNames(result.data.replacementItemId!)).toEqual(
      new Set(["کوچک"]),
    );
    expect(await orderTotal(orderId)).toBe(3_900_000);
  });

  it("moves the line's inventory consumption onto the replacement", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);
    expect(await pendingConsumption(orderId)).toEqual({});

    const added = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId, shop.smallId],
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const withBread = added.data.replacementItemId!;
    expect(await snapshotQuantities(withBread)).toEqual({ [shop.flourId]: 50 });
    // The superseded line's own snapshot survives untouched (it is immutable),
    // but being voided it no longer counts toward what payment will deduct.
    expect(await pendingConsumption(orderId)).toEqual({ [shop.flourId]: 50 });

    const removed = await update(shop, orderId, withBread, {
      modifierIds: [shop.smallId],
    });
    expect(removed.ok).toBe(true);
    expect(await pendingConsumption(orderId)).toEqual({});
  });

  it("multiplies the replacement's consumption by its quantity", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);

    await update(shop, orderId, orderItemId, {
      quantity: 3,
      modifierIds: [shop.breadId, shop.smallId],
    });

    expect(await pendingConsumption(orderId)).toEqual({ [shop.flourId]: 150 });
  });

  it("refuses an add-on from a group this item does not carry, and writes nothing", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.smallId, shop.foreignId],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_modifier",
      status: 400,
    });
    expect(await lineStatus(orderItemId)).toMatchObject({ status: "sent" });
    expect(await liveLineCount(orderId)).toBe(1);
    expect(await orderTotal(orderId)).toBe(3_900_000);
  });

  it("refuses to leave a required group unselected", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_modifier_selection",
      status: 400,
    });
    expect(await lineStatus(orderItemId)).toMatchObject({ status: "sent" });
    expect(await addOnNames(orderItemId)).toEqual(new Set(["کوچک"]));
  });

  it("refuses to exceed a group's max_select", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.smallId, shop.largeId],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_modifier_selection",
      status: 400,
    });
    expect(await liveLineCount(orderId)).toBe(1);
  });

  it("refuses to edit a line of an order that is no longer open", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);
    await db.query(
      "UPDATE orders SET status = 'completed', closed_at = now() WHERE id = $1",
      [orderId],
    );

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId, shop.smallId],
    });

    expect(result).toMatchObject({ ok: false, error: "order_not_open" });
    expect(await liveLineCount(orderId)).toBe(1);
  });

  it("refuses an edit to a line that has already been voided", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);
    await update(shop, orderId, orderItemId, {
      void: { reason: "اشتباه ثبت شد" },
    });

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId, shop.smallId],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "item_already_voided",
      status: 409,
    });
  });

  it("carries quantity and note onto the replacement in the same transaction", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);

    const result = await update(shop, orderId, orderItemId, {
      quantity: 3,
      note: "  بدون پیاز  ",
      modifierIds: [shop.breadId, shop.smallId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await lineStatus(result.data.replacementItemId!)).toMatchObject({
      quantity: 3,
      note: "بدون پیاز",
    });
    expect(await orderTotal(orderId)).toBe((3_900_000 + 300_000) * 3);
  });

  it("keeps the untouched note and quantity when only add-ons change", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [shop.smallId]);
    await update(shop, orderId, orderItemId, { quantity: 2, note: "کم‌نمک" });

    const result = await update(shop, orderId, orderItemId, {
      modifierIds: [shop.breadId, shop.smallId],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await lineStatus(result.data.replacementItemId!)).toMatchObject({
      quantity: 2,
      note: "کم‌نمک",
    });
  });

  it("rejects a nonsense quantity without touching the add-ons", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [
      shop.breadId,
      shop.smallId,
    ]);

    const result = await update(shop, orderId, orderItemId, {
      quantity: 0,
      modifierIds: [shop.smallId],
    });

    expect(result).toMatchObject({
      ok: false,
      error: "invalid_item",
      status: 400,
    });
    expect(await addOnNames(orderItemId)).toEqual(new Set(["نان", "کوچک"]));
    expect(await lineStatus(orderItemId)).toMatchObject({ status: "sent" });
  });

  it("still supports a plain quantity or note edit, with no replacement line", async () => {
    const shop = await createShop();
    const { orderId, orderItemId } = await openOrder(shop, [
      shop.breadId,
      shop.smallId,
    ]);

    const result = await update(shop, orderId, orderItemId, { quantity: 4 });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.replacementItemId).toBeNull();
    expect(await lineStatus(orderItemId)).toMatchObject({
      status: "sent",
      quantity: 4,
    });
    expect(await orderTotal(orderId)).toBe(4_200_000 * 4);
  });
});
