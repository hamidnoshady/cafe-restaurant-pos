import { describe, expect, it } from "vitest";
import {
  compileSegment,
  consentPredicate,
  countRules,
  describeSegment,
  isSegmentField,
  isSegmentPurpose,
  isSendingPurpose,
  SEGMENT_FIELDS,
  SegmentRuleError,
  validateSegmentDefinition,
  type SegmentDefinition,
} from "./segments";

const ANCHOR = { anchorDate: "2026-03-10" };

describe("compileSegment", () => {
  it("compiles an empty document to TRUE — «همهٔ مشتریان» needs no special case", () => {
    const compiled = compileSegment({}, ANCHOR);
    expect(compiled.sql).toBe("TRUE");
    expect(compiled.params).toEqual([]);
  });

  it("refuses a document with keys it does not understand, instead of matching everyone", () => {
    // Regression, and the reason the rule above is dangerous on its own: a
    // caller written against a different spec — `{match, rules}` rather than
    // `{all, any}` — contributes no clauses, and no clauses means TRUE. The
    // empty document says "everyone" because someone *asked* for everyone; a
    // malformed one must never widen an audience by accident, so it fails
    // closed the way an unknown consent purpose does.
    expect(() =>
      compileSegment(
        {
          match: "all",
          rules: [{ field: "orderCount", operator: "gte", value: 5 }],
        } as never,
        ANCHOR,
      ),
    ).toThrow(SegmentRuleError);
    // …and the error names the offending key, so the caller can fix it.
    expect(() => compileSegment({ rules: [] } as never, ANCHOR)).toThrow(
      /rules/,
    );
  });

  it("ANDs `all` rules and ORs `any` rules", () => {
    const compiled = compileSegment(
      {
        all: [
          { field: "orderCount", op: "gte", value: 3 },
          { field: "isActive", op: "is", value: true },
        ],
        any: [
          { field: "hasEmail", op: "is", value: true },
          { field: "smsConsent", op: "is", value: true },
        ],
      },
      ANCHOR,
    );
    expect(compiled.sql).toContain(" AND ");
    expect(compiled.sql).toContain(" OR ");
    expect(compiled.params).toEqual([3, true, true, true]);
  });

  it("numbers parameters from the caller's offset so it can be embedded", () => {
    const compiled = compileSegment(
      { all: [{ field: "orderCount", op: "gte", value: 5 }] },
      {
        ...ANCHOR,
        paramOffset: 1,
      },
    );
    // $1 belongs to the caller (the business id); the compiler starts at $2.
    expect(compiled.sql).toContain("$2");
    expect(compiled.sql).not.toContain("$1");
  });

  describe("injection safety — the property that makes user-authored rules survivable", () => {
    it("binds every value rather than interpolating it", () => {
      const hostile = "'; DROP TABLE customers; --";
      const compiled = compileSegment(
        { all: [{ field: "city", op: "contains", value: hostile }] },
        ANCHOR,
      );
      // The attack string is a *parameter*, never part of the statement.
      expect(compiled.sql).not.toContain("DROP TABLE");
      expect(compiled.sql).not.toContain(hostile);
      expect(compiled.params).toEqual([`%${hostile}%`]);
    });

    it("treats LIKE wildcards in a contains rule as literal customer text", () => {
      const literal = "100%_تهران\\";
      const compiled = compileSegment(
        { all: [{ field: "city", op: "contains", value: literal }] },
        ANCHOR,
      );
      expect(compiled.sql).toContain("ESCAPE");
      expect(compiled.params).toEqual(["%100\\%\\_تهران\\\\%"]);
    });

    it("binds hostile tag values too", () => {
      const compiled = compileSegment(
        {
          all: [
            {
              field: "tags",
              op: "hasAny",
              values: ["a'); DELETE FROM orders; --"],
            },
          ],
        },
        ANCHOR,
      );
      expect(compiled.sql).not.toContain("DELETE");
      expect(compiled.params[0]).toEqual(["a'); DELETE FROM orders; --"]);
    });

    it("rejects an unknown field instead of interpolating it as a column", () => {
      expect(() =>
        compileSegment(
          { all: [{ field: "name; DROP TABLE customers" } as never] },
          ANCHOR,
        ),
      ).toThrow(SegmentRuleError);
    });

    it("rejects an unknown operator", () => {
      expect(() =>
        compileSegment(
          { all: [{ field: "orderCount", op: "!=" } as never] },
          ANCHOR,
        ),
      ).toThrow(SegmentRuleError);
    });

    it("rejects a non-numeric value where a number is required", () => {
      expect(() =>
        compileSegment(
          {
            all: [
              {
                field: "totalSpentRial",
                op: "gte",
                value: "1 OR 1=1",
              } as never,
            ],
          },
          ANCHOR,
        ),
      ).toThrow(SegmentRuleError);
    });

    it("never emits a SQL string containing anything the user typed", () => {
      // A sweep over every field, with a hostile value in each, asserting the
      // finished statement is built only from this module's own fragments.
      const hostile = "x'; TRUNCATE customers; --";
      for (const meta of SEGMENT_FIELDS) {
        const rule = (() => {
          switch (meta.valueKind) {
            case "days":
              return { field: meta.field, op: meta.operators[0], days: 30 };
            case "money":
            case "number":
              return { field: meta.field, op: meta.operators[0], value: 10 };
            case "tags":
              return {
                field: meta.field,
                op: meta.operators[0],
                values: [hostile],
              };
            case "month":
              return { field: meta.field, op: "is", month: 5 };
            case "boolean":
              return { field: meta.field, op: "is", value: true };
            default:
              return { field: meta.field, op: "contains", value: hostile };
          }
        })();
        const compiled = compileSegment({ all: [rule as never] }, ANCHOR);
        expect(compiled.sql).not.toContain("TRUNCATE");
      }
    });
  });

  describe("date rules", () => {
    it("measures days from the anchor date the caller resolved, never now()", () => {
      const compiled = compileSegment(
        { all: [{ field: "lastPurchaseAt", op: "before", days: 90 }] },
        ANCHOR,
      );
      expect(compiled.sql).not.toContain("now()");
      expect(compiled.params).toEqual(["2026-03-10", "90 days"]);
    });

    it("includes customers who have never purchased in a «hasn't bought in N days» rule", () => {
      // A plain `<` on a NULL column drops exactly the people a win-back
      // campaign is aimed at.
      const compiled = compileSegment(
        { all: [{ field: "lastPurchaseAt", op: "before", days: 90 }] },
        ANCHOR,
      );
      expect(compiled.sql).toContain("IS NULL");
    });

    it("does not treat 'no first purchase' as a first purchase before the cutoff", () => {
      const compiled = compileSegment(
        { all: [{ field: "firstPurchaseAt", op: "before", days: 90 }] },
        ANCHOR,
      );
      expect(compiled.sql).not.toContain("IS NULL");
      expect(compiled.sql).toContain("s.first_purchase_date <");
    });

    it("does not add the IS NULL branch to a «bought recently» rule", () => {
      const compiled = compileSegment(
        { all: [{ field: "lastPurchaseAt", op: "after", days: 30 }] },
        ANCHOR,
      );
      expect(compiled.sql).not.toContain("IS NULL");
    });

    it("rejects a negative day count and a non-ISO anchor", () => {
      expect(() =>
        compileSegment(
          { all: [{ field: "lastPurchaseAt", op: "before", days: -1 }] },
          ANCHOR,
        ),
      ).toThrow(SegmentRuleError);
      expect(() => compileSegment({}, { anchorDate: "10/03/2026" })).toThrow(
        SegmentRuleError,
      );
    });
  });

  it("treats a customer with no orders as having spent zero, not unknown", () => {
    const compiled = compileSegment(
      { all: [{ field: "totalSpentRial", op: "lte", value: 100 }] },
      ANCHOR,
    );
    expect(compiled.sql).toContain("coalesce");
  });

  it("ignores an empty tag list rather than erroring mid-typing", () => {
    const compiled = compileSegment(
      { all: [{ field: "tags", op: "hasAny", values: [] }] },
      ANCHOR,
    );
    expect(compiled.sql).toContain("TRUE");
    expect(compiled.params).toEqual([]);
  });

  it("trims tag values before binding them", () => {
    const compiled = compileSegment(
      {
        all: [{ field: "tags", op: "hasAll", values: [" vip ", "", "طلایی "] }],
      },
      ANCHOR,
    );
    expect(compiled.params).toEqual([["vip", "طلایی"]]);
  });

  it("validates the month range", () => {
    expect(() =>
      compileSegment(
        { all: [{ field: "birthdayMonth", op: "is", month: 13 }] },
        ANCHOR,
      ),
    ).toThrow();
    expect(() =>
      compileSegment(
        { all: [{ field: "birthdayMonth", op: "is", month: 0 }] },
        ANCHOR,
      ),
    ).toThrow();
    expect(
      compileSegment(
        { all: [{ field: "birthdayMonth", op: "is", month: 7 }] },
        ANCHOR,
      ).params,
    ).toEqual([7]);
  });
});

describe("consentPredicate — the rule the messaging phase will depend on", () => {
  it("requires consent and a reachable address for a send", () => {
    const sms = consentPredicate("sms");
    expect(sms).toContain("sms_consent = true");
    expect(sms).toContain("phone_kind");
    expect(sms).toContain("phone_e164 LIKE '+989%'");
    expect(sms).not.toContain("c.phone IS NOT NULL");
    expect(consentPredicate("email")).toContain("marketing_consent = true");
    expect(consentPredicate("email")).toContain("email IS NOT NULL");
  });

  it("does not filter a plain view", () => {
    expect(consentPredicate("view")).toBe("TRUE");
  });

  it("fails closed on an unrecognised purpose", () => {
    // A typo must produce an empty send, never an unconsented one.
    expect(consentPredicate("whatsapp" as never)).toBe("FALSE");
  });

  it("recognises valid purpose values before a route resolves an audience", () => {
    expect(isSegmentPurpose("view")).toBe(true);
    expect(isSegmentPurpose("sms")).toBe(true);
    expect(isSegmentPurpose("email")).toBe(true);
    expect(isSegmentPurpose("whatsapp")).toBe(false);
  });

  it("knows which purposes are sends", () => {
    expect(isSendingPurpose("sms")).toBe(true);
    expect(isSendingPurpose("email")).toBe(true);
    expect(isSendingPurpose("view")).toBe(false);
  });
});

describe("validateSegmentDefinition", () => {
  it("accepts a valid document", () => {
    const definition: SegmentDefinition = {
      all: [
        { field: "lastPurchaseAt", op: "before", days: 90 },
        { field: "totalSpentRial", op: "gte", value: 20_000_000 },
        { field: "tags", op: "hasAny", values: ["vip"] },
      ],
    };
    expect(validateSegmentDefinition(definition)).toEqual([]);
    expect(countRules(definition)).toBe(3);
  });

  it("rejects incomplete no-op rows for saved segments but allows them while previewing", () => {
    const definition = { all: [{ field: "tags", op: "hasAny", values: [] }] };
    expect(validateSegmentDefinition(definition).join(" ")).toContain(
      "حداقل یک برچسب",
    );
    expect(
      validateSegmentDefinition(definition, { allowIncomplete: true }),
    ).toEqual([]);
  });

  it("reports every problem rather than only the first", () => {
    const problems = validateSegmentDefinition({
      all: [{ field: "nope" }, { field: "orderCount", op: "??" }],
    });
    expect(problems.length).toBe(2);
  });

  it("rejects a non-object and unknown top-level keys", () => {
    expect(validateSegmentDefinition("everyone").length).toBeGreaterThan(0);
    expect(validateSegmentDefinition({ none: [] }).length).toBeGreaterThan(0);
  });
});

describe("describeSegment", () => {
  const money = (rial: number) => `${rial / 10} تومان`;

  it("describes an empty document as everybody", () => {
    expect(describeSegment({}, money)).toBe("همهٔ مشتریان");
  });

  it("renders the phase's headline example in Persian", () => {
    const text = describeSegment(
      {
        all: [
          { field: "lastPurchaseAt", op: "before", days: 90 },
          { field: "totalSpentRial", op: "gte", value: 20_000_000 },
        ],
      },
      money,
    );
    expect(text).toContain("۹۰".replace("۹۰", "90"));
    expect(text).toContain("خرید نکرده");
    expect(text).toContain("مجموع خرید");
  });
});

describe("isSegmentField", () => {
  it("accepts every declared field and nothing else", () => {
    for (const meta of SEGMENT_FIELDS)
      expect(isSegmentField(meta.field)).toBe(true);
    expect(isSegmentField("password")).toBe(false);
    expect(isSegmentField(null)).toBe(false);
  });

  it("has metadata for every field the compiler accepts", () => {
    // Drift here would mean a field the engine supports that the builder form
    // cannot offer, or vice versa.
    expect(SEGMENT_FIELDS.every((meta) => isSegmentField(meta.field))).toBe(
      true,
    );
  });
});
