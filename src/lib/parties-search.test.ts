import { describe, expect, it } from "vitest";
import { partySearchClause } from "./parties-service";

/**
 * The one definition of "matches what I typed".
 *
 * Every app's party list — the directory, the till picker and Growth's customer
 * projection — is built from `partySearchClause`. These are the properties a
 * screen that reuses it is relying on; each of them is a bug that shipped.
 */

/** No DEK is configured under test, so the clause is built key-less — the transition state. */
async function clause(term: string, firstParam = 2, alias = "c.") {
  return partySearchClause("business-1", term, firstParam, alias);
}

describe("partySearchClause", () => {
  it("strips every non-digit from the stored phone, not the letter D", async () => {
    // `'\D'` inside a JS template literal is not an escape sequence, so it
    // collapsed to the plain letter `D`: the clause deleted literal Ds and left
    // the spaces in «۰۹۱۲ ۳۴۵ ۶۷۸۹», which meant the digit-run search — the only
    // reason this branch exists — never matched a number with separators.
    const { sql } = await clause("09123456789");
    expect(sql).toContain("'\\D'");
    expect(sql).not.toContain("translate(c.phone, '۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩', '01234567890123456789'), 'D'");
  });

  it("escapes LIKE wildcards in the typed term", async () => {
    // «%» typed into a customer search must look for a percent sign, not match
    // every party in the business.
    const { sql, params } = await clause("50% off_now");
    expect(params[0]).toBe("%50\\% off\\_now%");
    expect(sql).toContain("ESCAPE '\\'");
  });

  it("escapes a typed backslash before it can eat the next character", async () => {
    const { params } = await clause("a\\b");
    expect(params[0]).toBe("%a\\\\b%");
  });

  it("reads a Persian-digit phone as the number it is", async () => {
    // «۰۹۱۲۳۴۵۶۷۸۹» and «09123456789» are one person to the till and to Growth.
    const { params } = await clause("۰۹۱۲۳۴۵۶۷۸۹");
    expect(params[3]).toBe("09123456789");
    expect(params[4]).toBe("+989123456789");
  });

  it("declines to match on a digit run shorter than four", async () => {
    const { params } = await clause("۱۲");
    expect(params[3]).toBeNull();
  });

  it("numbers its parameters from the slot the caller has reached", async () => {
    // Growth's projection already holds $1 (the business) before it appends this
    // clause; an off-by-one here silently compares the wrong values.
    const { sql, params } = await clause("ali", 5);
    expect(params).toHaveLength(5);
    expect(sql).toContain("$5");
    expect(sql).toContain("$9");
    expect(sql).not.toContain("$10");
  });

  it("qualifies every column with the caller's alias", async () => {
    const { sql } = await clause("ali", 2, "c.");
    for (const column of ["name", "phone", "phone_bidx", "phone_last4", "phone_e164"]) {
      expect(sql).toContain(`c.${column}`);
    }
    expect(sql).not.toMatch(/(?<![\w.])p\.name/);
  });
});
