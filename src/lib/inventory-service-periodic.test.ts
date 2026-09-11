/**
 * سیستم ادواری — the settings readers in inventory-service.ts and the
 * periodic early-return in deductForOrder, through a scripted PoolClient
 * (and a mocked settings module for the client-less read path).
 *
 * The contract pinned here is the compatibility rule the CostingSetting
 * comment states: a setting written before the periodic system existed has
 * no `system` field and means "perpetual" — and a business with no costing
 * setting at all is perpetual with FIFO, the defaults the whole app assumes.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PoolClient } from "pg";
import * as settings from "./settings";
import { deductForOrder, getCostingMethod, getInventorySystem } from "./inventory-service";

vi.mock("./settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./settings")>();
  return { ...actual, getSetting: vi.fn() };
});

interface Call {
  sql: string;
  params: unknown[];
}

function scriptedClient(respond: (sql: string, params: unknown[]) => Record<string, unknown>[] | undefined) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const flat = sql.replace(/\s+/g, " ").trim();
      calls.push({ sql: flat, params });
      const rows = respond(flat, params);
      if (rows === undefined) throw new Error(`unexpected query: ${flat}`);
      return { rows, rowCount: rows.length };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const settingsResponder =
  (value: unknown) =>
  (sql: string): Record<string, unknown>[] | undefined =>
    sql.includes("FROM settings") ? (value === null ? [] : [{ value }]) : undefined;

beforeEach(() => {
  vi.mocked(settings.getSetting).mockReset();
});

describe("getInventorySystem", () => {
  it("reads periodic off the costing setting (transaction client)", async () => {
    const { client, calls } = scriptedClient(
      settingsResponder({ method: "weighted_average", system: "periodic", lockedAt: null }),
    );
    expect(await getInventorySystem("biz-1", client)).toBe("periodic");
    expect(calls[0].params).toEqual(["biz-1", settings.SETTING_KEYS.costing]);
  });

  it("defaults to perpetual when the setting predates the periodic system (no `system` field)", async () => {
    const { client } = scriptedClient(settingsResponder({ method: "fifo", lockedAt: null }));
    expect(await getInventorySystem("biz-1", client)).toBe("perpetual");
  });

  it("defaults to perpetual when there is no costing setting at all", async () => {
    const { client } = scriptedClient(settingsResponder(null));
    expect(await getInventorySystem("biz-1", client)).toBe("perpetual");
  });

  it("reads through getSetting when called without a client, with the same defaults", async () => {
    vi.mocked(settings.getSetting).mockResolvedValueOnce({ method: "lifo", system: "periodic", lockedAt: null });
    expect(await getInventorySystem("biz-1")).toBe("periodic");

    vi.mocked(settings.getSetting).mockResolvedValueOnce(null);
    expect(await getInventorySystem("biz-1")).toBe("perpetual");

    expect(settings.getSetting).toHaveBeenCalledWith("biz-1", settings.SETTING_KEYS.costing);
  });
});

describe("getCostingMethod", () => {
  it("reads the locked method, lifo included (transaction client)", async () => {
    const { client } = scriptedClient(
      settingsResponder({ method: "lifo", system: "perpetual", lockedAt: null }),
    );
    expect(await getCostingMethod("biz-1", client)).toBe("lifo");
  });

  it("defaults to fifo when there is no costing setting", async () => {
    const { client } = scriptedClient(settingsResponder(null));
    expect(await getCostingMethod("biz-1", client)).toBe("fifo");

    vi.mocked(settings.getSetting).mockResolvedValueOnce(null);
    expect(await getCostingMethod("biz-1")).toBe("fifo");
  });
});

describe("deductForOrder under سیستم ادواری", () => {
  it("returns zero cost without touching order items, recipes or stock", async () => {
    const { client, calls } = scriptedClient(
      settingsResponder({ method: "weighted_average", system: "periodic", lockedAt: null }),
    );

    const result = await deductForOrder(client, "biz-1", "loc-1", "order-1", "user-1", "event-1");

    // Zero cost also means postExactCogsEntry drops all lines downstream —
    // the sale posts revenue only, which is the periodic contract.
    expect(result).toEqual({ totalCost: "0" });

    // The only query issued is the settings read: no order_items select, no
    // consumption, no stock movement.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("FROM settings");
  });
});
