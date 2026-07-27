import { describe, expect, it } from "vitest";
import { sqlLiteral, tenantDataToSql, type TenantExportTable } from "./tenant-export";

describe("sqlLiteral", () => {
  it("renders null/undefined as NULL", () => {
    expect(sqlLiteral(null)).toBe("NULL");
    expect(sqlLiteral(undefined)).toBe("NULL");
  });

  it("renders booleans unquoted", () => {
    expect(sqlLiteral(true)).toBe("TRUE");
    expect(sqlLiteral(false)).toBe("FALSE");
  });

  it("renders numbers unquoted", () => {
    expect(sqlLiteral(42)).toBe("42");
    expect(sqlLiteral(0)).toBe("0");
  });

  it("renders a Date as a quoted ISO timestamp", () => {
    const d = new Date("2026-01-15T10:30:00.000Z");
    expect(sqlLiteral(d)).toBe("'2026-01-15T10:30:00.000Z'");
  });

  it("escapes single quotes in strings by doubling them", () => {
    expect(sqlLiteral("O'Brien's")).toBe("'O''Brien''s'");
  });

  it("renders a plain string (uuid, text, bigint-as-string) as a quoted literal", () => {
    expect(sqlLiteral("11111111-1111-1111-1111-111111111111")).toBe(
      "'11111111-1111-1111-1111-111111111111'",
    );
  });

  it("renders an array as a Postgres '{a,b}' array literal", () => {
    expect(sqlLiteral(["a", "b"])).toBe(`'{"a","b"}'`);
  });

  it("renders an empty array as '{}', not the untyped ARRAY[] form", () => {
    expect(sqlLiteral([])).toBe("'{}'");
  });

  it("escapes double quotes and backslashes inside array elements", () => {
    expect(sqlLiteral(['a"b', "c\\d"])).toBe(`'{"a\\"b","c\\\\d"}'`);
  });

  it("renders NULL elements inside an array unquoted", () => {
    expect(sqlLiteral([null, "a"])).toBe(`'{NULL,"a"}'`);
  });

  it("renders a plain object (jsonb) as a quoted JSON string", () => {
    expect(sqlLiteral({ granted: ["x"] })).toBe(`'{"granted":["x"]}'`);
  });

  it("escapes single quotes inside a JSON object literal", () => {
    expect(sqlLiteral({ note: "O'Brien" })).toBe(`'{"note":"O''Brien"}'`);
  });
});

describe("tenantDataToSql", () => {
  it("wraps every INSERT in a single transaction", () => {
    const tables: TenantExportTable[] = [
      { name: "businesses", columns: ["id", "name"], rows: [{ id: "1", name: "Cafe" }] },
    ];
    const sql = tenantDataToSql(tables);
    expect(sql.startsWith("--")).toBe(true);
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain(`INSERT INTO "businesses" ("id", "name") OVERRIDING SYSTEM VALUE VALUES ('1', 'Cafe');`);
    expect(sql.trim().endsWith("COMMIT;")).toBe(true);
  });

  it("emits one INSERT per row, in the table's own row order", () => {
    const tables: TenantExportTable[] = [
      {
        name: "locations",
        columns: ["id", "name"],
        rows: [
          { id: "a", name: "Main" },
          { id: "b", name: "Branch" },
        ],
      },
    ];
    const sql = tenantDataToSql(tables);
    const lines = sql.split("\n").filter((l) => l.startsWith("INSERT"));
    expect(lines).toEqual([
      `INSERT INTO "locations" ("id", "name") OVERRIDING SYSTEM VALUE VALUES ('a', 'Main');`,
      `INSERT INTO "locations" ("id", "name") OVERRIDING SYSTEM VALUE VALUES ('b', 'Branch');`,
    ]);
  });

  it("emits tables in the order given (dependency order is the caller's job)", () => {
    const tables: TenantExportTable[] = [
      { name: "locations", columns: ["id"], rows: [{ id: "1" }] },
      { name: "orders", columns: ["id"], rows: [{ id: "2" }] },
    ];
    const sql = tenantDataToSql(tables);
    expect(sql.indexOf('"locations"')).toBeLessThan(sql.indexOf('"orders"'));
  });

  it("produces just the transaction wrapper for no tables", () => {
    expect(tenantDataToSql([])).toBe(
      [
        "-- Per-tenant data export (Phase 17). Restore into an already-migrated,",
        "-- otherwise-empty database — this carries data only, no schema.",
        "BEGIN;",
        "SET LOCAL session_replication_role = replica;",
        "COMMIT;",
      ].join("\n"),
    );
  });

  it("skips ordinary triggers for the duration of the restore transaction", () => {
    const tables: TenantExportTable[] = [{ name: "orders", columns: ["id"], rows: [{ id: "1" }] }];
    expect(tenantDataToSql(tables)).toContain("SET LOCAL session_replication_role = replica;");
  });
});
