import { describe, expect, it } from "vitest";
import { selfReferencingColumns, sortRowsByParent, topoSortTables, type ForeignKeyEdge } from "./tenant-tables";

describe("topoSortTables", () => {
  it("puts a table after every table its foreign keys point to", () => {
    const edges: ForeignKeyEdge[] = [
      { table: "order_items", column: "order_id", foreignTable: "orders" },
      { table: "orders", column: "location_id", foreignTable: "locations" },
    ];
    const order = topoSortTables(["order_items", "orders", "locations"], edges);
    expect(order.indexOf("locations")).toBeLessThan(order.indexOf("orders"));
    expect(order.indexOf("orders")).toBeLessThan(order.indexOf("order_items"));
  });

  it("ignores a self-referencing edge (table-level concern doesn't apply to it)", () => {
    const edges: ForeignKeyEdge[] = [{ table: "accounts", column: "parent_id", foreignTable: "accounts" }];
    expect(topoSortTables(["accounts"], edges)).toEqual(["accounts"]);
  });

  it("ignores edges pointing outside the given table set", () => {
    const edges: ForeignKeyEdge[] = [{ table: "orders", column: "location_id", foreignTable: "locations" }];
    // "locations" isn't in the set being sorted (e.g. it's exempt or already placed elsewhere).
    expect(topoSortTables(["orders"], edges)).toEqual(["orders"]);
  });

  it("degrades to insertion order rather than looping forever on a cross-table cycle", () => {
    const edges: ForeignKeyEdge[] = [
      { table: "a", column: "b_id", foreignTable: "b" },
      { table: "b", column: "a_id", foreignTable: "a" },
    ];
    const order = topoSortTables(["a", "b"], edges);
    expect(order.sort()).toEqual(["a", "b"]);
  });

  it("includes every table exactly once, regardless of edge order", () => {
    const edges: ForeignKeyEdge[] = [
      { table: "c", column: "b_id", foreignTable: "b" },
      { table: "b", column: "a_id", foreignTable: "a" },
    ];
    expect(topoSortTables(["c", "b", "a"], edges).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("sortRowsByParent", () => {
  it("puts a parent row before its child", () => {
    const rows = [
      { id: "child", parent_id: "root" },
      { id: "root", parent_id: null },
    ];
    const sorted = sortRowsByParent(rows, "id", "parent_id");
    expect(sorted.map((r) => r.id)).toEqual(["root", "child"]);
  });

  it("handles multi-level chains regardless of input order", () => {
    const rows = [
      { id: "grandchild", parent_id: "child" },
      { id: "child", parent_id: "root" },
      { id: "root", parent_id: null },
    ];
    const sorted = sortRowsByParent(rows, "id", "parent_id");
    expect(sorted.map((r) => r.id)).toEqual(["grandchild", "child", "root"].reverse());
  });

  it("leaves independent roots in their relative order", () => {
    const rows = [
      { id: "a", parent_id: null },
      { id: "b", parent_id: null },
    ];
    expect(sortRowsByParent(rows, "id", "parent_id").map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("doesn't loop forever on a malformed cycle", () => {
    const rows = [
      { id: "x", parent_id: "y" },
      { id: "y", parent_id: "x" },
    ];
    expect(() => sortRowsByParent(rows, "id", "parent_id")).not.toThrow();
  });
});

describe("selfReferencingColumns", () => {
  it("finds a table's own parent-pointer column", () => {
    const edges: ForeignKeyEdge[] = [
      { table: "accounts", column: "parent_id", foreignTable: "accounts" },
      { table: "orders", column: "location_id", foreignTable: "locations" },
    ];
    const map = selfReferencingColumns(edges);
    expect(map.get("accounts")).toBe("parent_id");
    expect(map.has("orders")).toBe(false);
  });
});
