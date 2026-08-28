import { describe, expect, it } from "vitest";
import {
  armDirectSql,
  buildDirectSqlPreview,
  HOLOO_DIRECT_SQL_CONFIRMATION_PHRASE,
  isPinnedProfile,
} from "./direct-sql";

describe("armDirectSql", () => {
  it("arms only on the exact typed phrase", () => {
    expect(armDirectSql(HOLOO_DIRECT_SQL_CONFIRMATION_PHRASE)).toEqual({ ok: true });
    expect(armDirectSql("delete-me")).toEqual({ ok: false, error: "confirmation_mismatch" });
    expect(armDirectSql("")).toEqual({ ok: false, error: "confirmation_mismatch" });
  });
});

describe("isPinnedProfile", () => {
  it("requires both a probed and a pinned profile, and that they match", () => {
    expect(isPinnedProfile("holoo-generic", "holoo-generic")).toBe(true);
    expect(isPinnedProfile("holoo-generic", "holoo-other")).toBe(false);
    expect(isPinnedProfile(null, "holoo-generic")).toBe(false);
    expect(isPinnedProfile("holoo-generic", undefined)).toBe(false);
  });
});

describe("buildDirectSqlPreview", () => {
  it("renders the exact statements, with source ids in comments", () => {
    const { statements } = buildDirectSqlPreview(
      [
        { sourceId: "s1", kind: "sale", values: [1, "قند", 12000] },
        { sourceId: "s2", kind: "receipt", values: ["o'brien", null] },
      ],
      (kind) => (kind === "sale" ? "SellInvoice" : "ReceivePay"),
    );
    expect(statements[0]).toBe("INSERT INTO [SellInvoice] VALUES (1, 'قند', 12000); -- source_id=s1");
    expect(statements[1]).toBe("INSERT INTO [ReceivePay] VALUES ('o''brien', NULL); -- source_id=s2");
  });
});
