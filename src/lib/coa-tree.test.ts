import { describe, expect, it } from "vitest";
import {
  accountSearchHaystack,
  buildAccountTree,
  canEditChartOfAccounts,
  collectDescendantIds,
  compareAccountCodes,
  matchesAccountSearch,
} from "./coa-tree";
import { PERMISSIONS, roleBasePermissions } from "./permissions";

function account(id: string, code: string, parentId: string | null = null) {
  return { id, code, parentId };
}

describe("compareAccountCodes", () => {
  it("orders numeric codes by value, not by string", () => {
    expect(compareAccountCodes("1100", "1300")).toBeLessThan(0);
    // The bug a plain string sort has: "99" sorts after "100" lexically.
    expect(compareAccountCodes("99", "100")).toBeLessThan(0);
  });

  it("still orders non-numeric schemes sensibly", () => {
    expect(compareAccountCodes("A-10", "A-20")).toBeLessThan(0);
  });
});

describe("buildAccountTree", () => {
  it("puts every parent immediately above its children, whatever the codes are", () => {
    // 5900 sorts after 5310, so a flat ORDER BY code puts the child of 5300
    // nowhere near it. The tree must not care.
    const rows = buildAccountTree([
      account("expenses", "5000"),
      account("rent", "5900", "expenses"),
      account("marketing", "5310", "expenses"),
      account("cash", "1100"),
    ]);
    expect(rows.map((r) => r.account.code)).toEqual(["1100", "5000", "5310", "5900"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 0, 1, 1]);
  });

  it("reports the real depth down a four-tier chain", () => {
    const rows = buildAccountTree([
      account("tafsili", "6111", "moein"),
      account("group", "6000"),
      account("moein", "6110", "kol"),
      account("kol", "6100", "group"),
    ]);
    expect(rows.map((r) => r.account.code)).toEqual(["6000", "6100", "6110", "6111"]);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  it("treats an account whose parent is absent from the list as a root", () => {
    // A filtered list hands us exactly this; dropping the row would hide an
    // account from its own management screen.
    const rows = buildAccountTree([account("orphan", "5310", "not-in-this-list")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depth: 0 });
  });

  it("keeps every account even when the data contains a cycle", () => {
    // accounts.parent_id has no DB-level cycle guard — only assertNoCycle at
    // write time. A cycle must not hang or swallow rows.
    const rows = buildAccountTree([account("a", "1000", "b"), account("b", "2000", "a")]);
    expect(rows.map((r) => r.account.id).sort()).toEqual(["a", "b"]);
  });

  it("returns an empty list for no accounts", () => {
    expect(buildAccountTree([])).toEqual([]);
  });
});

describe("collectDescendantIds", () => {
  const chart = [
    account("group", "5000"),
    account("kol", "5300", "group"),
    account("moein", "5310", "kol"),
    account("other", "1100"),
  ];

  it("collects the whole subtree, at any depth", () => {
    expect(collectDescendantIds(chart, "group")).toEqual(new Set(["kol", "moein"]));
  });

  it("excludes the root itself and unrelated branches", () => {
    const descendants = collectDescendantIds(chart, "kol");
    expect(descendants.has("kol")).toBe(false);
    expect(descendants.has("other")).toBe(false);
    expect(descendants.has("moein")).toBe(true);
  });

  it("is empty for a leaf", () => {
    expect(collectDescendantIds(chart, "moein").size).toBe(0);
  });

  it("terminates on a cycle without ever returning the root", () => {
    const cyclic = [account("a", "1000", "b"), account("b", "2000", "a")];
    expect(collectDescendantIds(cyclic, "a")).toEqual(new Set(["b"]));
  });
});

describe("account search", () => {
  const haystack = accountSearchHaystack(["6100", "هزینه‌های فروش", "5000", "هزینه"]);

  it("matches Persian digits against ASCII codes", () => {
    // What a Persian keyboard actually produces when typing an account code.
    expect(matchesAccountSearch(haystack, "۶۱۰۰")).toBe(true);
    expect(matchesAccountSearch(haystack, "6100")).toBe(true);
  });

  it("matches Arabic-Indic digits too", () => {
    expect(matchesAccountSearch(haystack, "٦١٠٠")).toBe(true);
  });

  it("matches the Arabic ی/ك variants of a Persian name", () => {
    expect(matchesAccountSearch(accountSearchHaystack(["بانك ملی"]), "بانک")).toBe(true);
    expect(matchesAccountSearch(accountSearchHaystack(["مشتری"]), "مشتري")).toBe(true);
  });

  it("requires every term, so more words narrow the list", () => {
    expect(matchesAccountSearch(haystack, "هزینه فروش")).toBe(true);
    expect(matchesAccountSearch(haystack, "هزینه بانک")).toBe(false);
  });

  it("matches on the parent code, so a family can be listed", () => {
    expect(matchesAccountSearch(haystack, "5000")).toBe(true);
  });

  it("treats an empty or whitespace query as no filter", () => {
    expect(matchesAccountSearch(haystack, "")).toBe(true);
    expect(matchesAccountSearch(haystack, "   ")).toBe(true);
  });

  it("ignores a stray extra space between terms", () => {
    expect(matchesAccountSearch(haystack, "  هزینه   فروش ")).toBe(true);
  });
});

describe("canEditChartOfAccounts", () => {
  it("follows the member's effective permissions when they are known", () => {
    expect(canEditChartOfAccounts("manager", [PERMISSIONS.accountsEdit])).toBe(true);
    expect(canEditChartOfAccounts("accountant", [PERMISSIONS.ledgerView])).toBe(false);
  });

  it("falls back to the role presets when they are not", () => {
    expect(canEditChartOfAccounts("owner")).toBe(true);
    expect(canEditChartOfAccounts("accountant")).toBe(true);
    // The bug this gate exists for: a manager may open «سرفصل حساب‌ها» but
    // every write behind it answers 403.
    expect(canEditChartOfAccounts("manager")).toBe(false);
    expect(canEditChartOfAccounts("cashier")).toBe(false);
    expect(canEditChartOfAccounts(null)).toBe(false);
  });

  it("agrees with the role presets the API actually enforces", () => {
    // If a preset ever changes, this fails rather than letting the screen and
    // the route drift apart.
    for (const role of ["owner", "manager", "accountant", "cashier", "waiter", "kitchen"] as const) {
      const preset = roleBasePermissions(role).includes(PERMISSIONS.accountsEdit);
      expect(canEditChartOfAccounts(role), role).toBe(preset);
    }
  });

  it("treats an empty permission list as 'no rights', not as 'unknown'", () => {
    expect(canEditChartOfAccounts("owner", [])).toBe(false);
  });
});
