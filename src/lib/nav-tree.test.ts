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
      { label: "افزودن محصول", href: "/dashboard/products/new" },
      { label: "لیست محصولات", href: "/dashboard/products" },
      { label: "لیست قیمت", href: "/dashboard/products/prices" },
    ],
  },
  { label: "گزارش‌ها", href: "/dashboard/reports" },
];

/** The sidebar's own prefix rule, restated so the test does not import a client component. */
function isActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

describe("flattenNav", () => {
  test("reaches a group's sub-sections, which the top level alone never did", () => {
    expect(flattenNav(NAV).map((item) => item.href)).toEqual([
      "/dashboard/overview",
      "/dashboard/products/new",
      "/dashboard/products",
      "/dashboard/products/prices",
      "/dashboard/reports",
    ]);
  });

  test("drops a group that is only a heading, since it is not a page to open or pin", () => {
    expect(flattenNav(NAV).some((item) => item.label === "محصولات")).toBe(false);
  });

  test("an empty nav flattens to nothing rather than throwing", () => {
    expect(flattenNav([])).toEqual([]);
  });
});

describe("bestNavMatch", () => {
  const pages = flattenNav(NAV);

  test("titles a sub-section's page by its own name, not by its group's", () => {
    const match = bestNavMatch(pages, (href) => isActive("/dashboard/products/prices", href));
    expect(match?.label).toBe("لیست قیمت");
  });

  test("prefers the longest match, so a section and its page never both light up", () => {
    // Both `/dashboard/products` and `/dashboard/products/new` match this path.
    const match = bestNavMatch(pages, (href) => isActive("/dashboard/products/new", href));
    expect(match?.href).toBe("/dashboard/products/new");
  });

  test("still resolves a plain top-level page", () => {
    const match = bestNavMatch(pages, (href) => isActive("/dashboard/reports", href));
    expect(match?.label).toBe("گزارش‌ها");
  });

  test("returns nothing for a page that is in no menu, so the caller can fall back", () => {
    expect(bestNavMatch(pages, (href) => isActive("/dashboard/settings", href))).toBeUndefined();
  });
});
