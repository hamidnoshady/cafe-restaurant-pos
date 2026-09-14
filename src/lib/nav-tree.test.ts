import { describe, expect, test } from "vitest";
import { bestNavMatch, flattenNav, type NavNode } from "./nav-tree";

interface Item extends NavNode {
  label: string;
  href?: string;
  children?: Item[];
}

/** The shape the products workspace gives the nav: one group over five pages. */
const NAV: Item[] = [
  { label: "داشبورد", href: "/dashboard/overview" },
  {
    label: "محصولات",
    children: [
      { label: "افزودن محصول", href: "/accounting/products/new" },
      { label: "لیست محصولات", href: "/accounting/products" },
      { label: "لیست قیمت", href: "/accounting/products/prices" },
    ],
  },
  { label: "گزارش‌ها", href: "/accounting/reports" },
];

/** The sidebar's own prefix rule, restated so the test does not import a client component. */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

describe("flattenNav", () => {
  test("reaches a group's sub-sections, which the top level alone never did", () => {
    expect(flattenNav(NAV).map((item) => item.href)).toEqual([
      "/dashboard/overview",
      "/accounting/products/new",
      "/accounting/products",
      "/accounting/products/prices",
      "/accounting/reports",
    ]);
  });

  test("drops a group that is only a heading, since it is not a page to open or pin", () => {
    expect(flattenNav(NAV).some((item) => item.label === "محصولات")).toBe(
      false,
    );
  });

  test("an empty nav flattens to nothing rather than throwing", () => {
    expect(flattenNav([])).toEqual([]);
  });
});

describe("bestNavMatch", () => {
  const pages = flattenNav(NAV);

  test("titles a sub-section's page by its own name, not by its group's", () => {
    const match = bestNavMatch(pages, (href) =>
      isActive("/accounting/products/prices", href),
    );
    expect(match?.label).toBe("لیست قیمت");
  });

  test("prefers the longest match, so a section and its page never both light up", () => {
    // Both `/accounting/products` and `/accounting/products/new` match this path.
    const match = bestNavMatch(pages, (href) =>
      isActive("/accounting/products/new", href),
    );
    expect(match?.href).toBe("/accounting/products/new");
  });

  test("still resolves a plain top-level page", () => {
    const match = bestNavMatch(pages, (href) =>
      isActive("/accounting/reports", href),
    );
    expect(match?.label).toBe("گزارش‌ها");
  });

  test("returns nothing for a page that is in no menu, so the caller can fall back", () => {
    expect(
      bestNavMatch(pages, (href) => isActive("/dashboard/settings", href)),
    ).toBeUndefined();
  });
});
