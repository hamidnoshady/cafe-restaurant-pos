import { describe, expect, it } from "vitest";
import { PAIRING_SNAPSHOT_VERSION, validateSnapshot, type PairingSnapshot } from "./pairing-snapshot";

function validSnapshot(): PairingSnapshot {
  return {
    version: PAIRING_SNAPSHOT_VERSION,
    business: {
      id: "11111111-1111-1111-1111-111111111111",
      name: "کافه بهار",
      slug: "cafe-bahar",
      timezone: "Asia/Tehran",
    },
    location: {
      id: "22222222-2222-2222-2222-222222222222",
      name: "شعبه مرکزی",
      address: null,
      phone: null,
      timezone: "Asia/Tehran",
    },
    users: [
      {
        id: "33333333-3333-3333-3333-333333333333",
        role: "owner",
        fullName: "حمید",
        email: "owner@example.com",
        permissions: {},
        pinHash: null,
        passwordHash: "$2a$10$abcdefghijklmnopqrstuv",
        platformUserEmail: "owner@example.com",
        platformUserFullName: "حمید",
        platformUserPasswordHash: "$2a$10$abcdefghijklmnopqrstuv",
        locationIds: ["22222222-2222-2222-2222-222222222222"],
      },
    ],
    accounts: [
      { id: "44444444-4444-4444-4444-444444444444", parentCode: null, code: "1000", name: "دارایی", type: "asset" },
    ],
    menu: {
      categories: [
        { id: "55555555-5555-5555-5555-555555555555", name: "نوشیدنی گرم", sortOrder: 0, isActive: true },
      ],
      items: [
        {
          id: "66666666-6666-6666-6666-666666666666",
          categoryId: "55555555-5555-5555-5555-555555555555",
          name: "اسپرسو",
          description: null,
          sku: null,
          price: 850000,
          imageUrl: null,
          isActive: true,
          sortOrder: 0,
        },
      ],
    },
    settings: [{ key: "business.prefs", value: { currencyDisplay: "toman" } }],
    features: { inventory: true, ai_assistant: false },
    syncToken: "a".repeat(64),
  };
}

describe("validateSnapshot", () => {
  it("accepts a complete snapshot", () => {
    const result = validateSnapshot(validSnapshot());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.business.slug).toBe("cafe-bahar");
  });

  it("rejects a non-object", () => {
    expect(validateSnapshot(null)).toEqual({ ok: false, error: "snapshot_invalid" });
    expect(validateSnapshot("nope")).toEqual({ ok: false, error: "snapshot_invalid" });
    expect(validateSnapshot([])).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects an unknown version rather than guessing at the shape", () => {
    expect(validateSnapshot({ ...validSnapshot(), version: 2 })).toEqual({
      ok: false,
      error: "snapshot_invalid",
    });
    expect(validateSnapshot({ ...validSnapshot(), version: undefined })).toEqual({
      ok: false,
      error: "snapshot_invalid",
    });
  });

  it("rejects a missing business", () => {
    const s = validSnapshot() as unknown as Record<string, unknown>;
    delete s.business;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a business whose id is not a uuid", () => {
    const s = validSnapshot();
    s.business.id = "not-a-uuid";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("carries the business's industry across", () => {
    const s = validSnapshot();
    s.business.industry = "jewelry";
    const result = validateSnapshot(s);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.snapshot.business.industry).toBe("jewelry");
  });

  it("accepts a snapshot from an older central server that sends no industry", () => {
    // The desktop side then falls back to 'food_service' (pairing-apply.ts),
    // which is exactly what a paired install got before the field existed —
    // so an upgrade must not start rejecting in-flight pairings.
    const s = validSnapshot();
    expect(s.business.industry).toBeUndefined();
    expect(validateSnapshot(s).ok).toBe(true);
  });

  it("rejects an industry the app does not know", () => {
    const s = validSnapshot() as unknown as { business: Record<string, unknown> };
    s.business.industry = "bakery";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a location belonging to no business slug/timezone shape", () => {
    const s = validSnapshot() as unknown as Record<string, unknown>;
    s.location = { id: "22222222-2222-2222-2222-222222222222" };
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a snapshot with no users, since there would be nobody to sign in as", () => {
    const s = validSnapshot();
    s.users = [];
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a snapshot with no owner among its users", () => {
    const s = validSnapshot();
    s.users[0].role = "cashier";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a menu item priced as a float, since money is integer Rial", () => {
    const s = validSnapshot();
    s.menu.items[0].price = 12.5;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a negative price", () => {
    const s = validSnapshot();
    s.menu.items[0].price = -1;
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("rejects a sync token that is too short to be a real secret", () => {
    const s = validSnapshot();
    s.syncToken = "short";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts empty accounts, menu and settings — a business may be freshly provisioned", () => {
    const s = validSnapshot();
    s.accounts = [];
    s.menu = { categories: [], items: [] };
    s.settings = [];
    expect(validateSnapshot(s).ok).toBe(true);
  });

  it("rejects a menu item pointing at a category that is not in the snapshot", () => {
    const s = validSnapshot();
    s.menu.items[0].categoryId = "99999999-9999-9999-9999-999999999999";
    expect(validateSnapshot(s)).toEqual({ ok: false, error: "snapshot_invalid" });
  });

  it("accepts a menu item with no category", () => {
    const s = validSnapshot();
    s.menu.items[0].categoryId = null;
    expect(validateSnapshot(s).ok).toBe(true);
  });
});
