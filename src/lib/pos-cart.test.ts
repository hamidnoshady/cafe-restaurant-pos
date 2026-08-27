import { describe, expect, it } from "vitest";
import {
  addOrMergeLine,
  countLinesForItem,
  sameLineConfig,
  stepLastLineForItem,
  stepLineQuantity,
  upsertLine,
  type PosCartLine,
} from "./pos-cart";

function makeLine(overrides: Partial<PosCartLine> & { key: string }): PosCartLine {
  return {
    menuItemId: "coffee",
    name: "قهوه",
    unitPrice: 100_000,
    quantity: 1,
    taxRatePercent: 0,
    modifierIds: [],
    modifiers: [],
    note: "",
    ...overrides,
  };
}

describe("sameLineConfig", () => {
  it("merges same item + same add-ons + same note", () => {
    expect(
      sameLineConfig(
        makeLine({ key: "a", modifierIds: ["choc"] }),
        makeLine({ key: "b", modifierIds: ["choc"] }),
      ),
    ).toBe(true);
  });

  it("keeps apart different add-on configurations", () => {
    expect(
      sameLineConfig(
        makeLine({ key: "a", modifierIds: ["choc"] }),
        makeLine({ key: "b", modifierIds: [] }),
      ),
    ).toBe(false);
  });

  it("keeps apart different notes even with the same add-ons", () => {
    expect(
      sameLineConfig(
        makeLine({ key: "a", note: "بدون شکر" }),
        makeLine({ key: "b", note: "" }),
      ),
    ).toBe(false);
  });
});

describe("addOrMergeLine", () => {
  it("appends a differently-configured unit as its own line", () => {
    const withChocolate = makeLine({ key: "l1", modifierIds: ["choc"] });
    const plain = makeLine({ key: "l2", modifierIds: [] });
    const next = addOrMergeLine([withChocolate], plain);
    expect(next.map((line) => line.key)).toEqual(["l1", "l2"]);
    expect(next.map((line) => line.quantity)).toEqual([1, 1]);
  });

  it("merges an identical configuration by adding quantities", () => {
    const first = makeLine({ key: "l1", modifierIds: ["choc"] });
    const second = makeLine({ key: "l2", modifierIds: ["choc"], quantity: 2 });
    const next = addOrMergeLine([first], second);
    expect(next).toHaveLength(1);
    expect(next[0].quantity).toBe(3);
    expect(next[0].key).toBe("l1");
  });
});

describe("upsertLine (editing a cart line)", () => {
  it("replaces the line in place when the new configuration is unique", () => {
    const plain = makeLine({ key: "l1" });
    const withChocolate = makeLine({ key: "l2", modifierIds: ["choc"] });
    const edited = makeLine({ key: "l2", modifierIds: ["choc"], note: "بدون شکر" });
    const next = upsertLine([plain, withChocolate], "l2", edited);
    expect(next.map((line) => line.key)).toEqual(["l1", "l2"]);
    expect(next[1].note).toBe("بدون شکر");
  });

  it("merges into an identical line instead of leaving a duplicate", () => {
    // Editing the chocolate line to drop the chocolate joins the plain coffee.
    const plain = makeLine({ key: "l1", quantity: 1 });
    const withChocolate = makeLine({ key: "l2", modifierIds: ["choc"] });
    const edited = makeLine({ key: "l2", modifierIds: [] });
    const next = upsertLine([plain, withChocolate], "l2", edited);
    expect(next).toHaveLength(1);
    expect(next[0].key).toBe("l1");
    expect(next[0].quantity).toBe(2);
  });
});

describe("stepLineQuantity", () => {
  it("increments the targeted line only", () => {
    const a = makeLine({ key: "l1", modifierIds: ["choc"] });
    const b = makeLine({ key: "l2" });
    expect(stepLineQuantity([a, b], "l1", 1).map((line) => line.quantity)).toEqual([
      2,
      1,
    ]);
  });

  it("removes the line when the count reaches zero, leaving the others", () => {
    const a = makeLine({ key: "l1" });
    const b = makeLine({ key: "l2", modifierIds: ["choc"] });
    const next = stepLineQuantity([a, b], "l1", -1);
    expect(next.map((line) => line.key)).toEqual(["l2"]);
  });

  it("leaves the cart untouched for an unknown key", () => {
    const a = makeLine({ key: "l1" });
    expect(stepLineQuantity([a], "missing", -1)).toEqual([a]);
  });
});

describe("stepLastLineForItem", () => {
  it("moves the most recent line for the product, never an earlier variant", () => {
    // Coffee with chocolate added first, plain coffee after — the tile's − must
    // undo the last touch (plain), not touch the chocolate line.
    const withChocolate = makeLine({ key: "l1", modifierIds: ["choc"] });
    const plain = makeLine({ key: "l2", modifierIds: [] });
    const next = stepLastLineForItem([withChocolate, plain], "coffee", -1);
    expect(next.map((line) => line.key)).toEqual(["l1"]);
    expect(next[0].modifierIds).toEqual(["choc"]);
  });
});

describe("countLinesForItem", () => {
  it("counts distinct configurations, not total units", () => {
    const lines = [
      makeLine({ key: "l1", modifierIds: ["choc"], quantity: 3 }),
      makeLine({ key: "l2", modifierIds: [], quantity: 2 }),
      makeLine({ key: "l3", menuItemId: "tea", quantity: 1 }),
    ];
    expect(countLinesForItem(lines, "coffee")).toBe(2);
    expect(countLinesForItem(lines, "tea")).toBe(1);
    expect(countLinesForItem(lines, "cola")).toBe(0);
  });
});
