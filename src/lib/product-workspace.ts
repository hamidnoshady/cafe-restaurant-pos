/**
 * Phase 42 — the products workspace («مدیریت محصولات»).
 *
 * The retail trade-goods industries used to manage their catalogue inside
 * each trade's own page «کالاها» tab (the shared VariantsSection over
 * `items`/`item_stock`). The workspace is the catalogue's one door: a
 * collapsible sidebar group — افزودن محصول، لیست محصولات، لیست قیمت، ویژگی
 * محصول، الگوی بارکد وزنی (+ each trade's گزارش‌ها) — over `/dashboard/products/*`,
 * with the trade's own items/stock APIs still doing the writing. Jewellery
 * and watch keep their own managers: their subject is one weighted piece or
 * one serialised unit per row, not a priced variant board.
 *
 * Framework-free like `apps.ts`: the sidebar (layout.tsx), the page guards
 * and the API guards all read the same two tables below.
 */
import type { Industry } from "./industries";

/** The trades whose catalogue is the variant board this workspace manages. */
export const PRODUCT_WORKSPACE_INDUSTRIES = [
  "accessories",
  "cosmetics",
  "wholesale",
  "tools_fittings",
  "haberdashery",
] as const;
export type ProductWorkspaceIndustry = (typeof PRODUCT_WORKSPACE_INDUSTRIES)[number];

export function isProductWorkspaceIndustry(
  industry: Industry | null | undefined,
): industry is ProductWorkspaceIndustry {
  return (PRODUCT_WORKSPACE_INDUSTRIES as readonly string[]).includes(industry ?? "");
}

/**
 * The trade's own items/stock API prefix — the workspace's add form and the
 * stock panel write through the same routes the old «کالاها» tab used, so a
 * sale, a receipt and a catalogue edit stay one code path per trade.
 */
export function productApiBaseFor(industry: ProductWorkspaceIndustry): string {
  const map: Record<ProductWorkspaceIndustry, string> = {
    accessories: "/api/accessories",
    cosmetics: "/api/cosmetics",
    wholesale: "/api/wholesale",
    tools_fittings: "/api/tools-fittings",
    haberdashery: "/api/haberdashery",
  };
  return map[industry];
}

/** The sidebar group's sub-sections, in the order the reference seats them. */
export const PRODUCT_WORKSPACE_SECTIONS = [
  { key: "new", label: "افزودن محصول", href: "/dashboard/products/new" },
  { key: "list", label: "لیست محصولات", href: "/dashboard/products" },
  { key: "prices", label: "لیست قیمت", href: "/dashboard/products/prices" },
  { key: "attributes", label: "ویژگی محصول", href: "/dashboard/products/attributes" },
  { key: "barcodes", label: "الگوی بارکد وزنی", href: "/dashboard/products/barcode-templates" },
  { key: "reports", label: "گزارش‌ها", href: "/dashboard/products/reports" },
] as const;
export type ProductWorkspaceSectionKey = (typeof PRODUCT_WORKSPACE_SECTIONS)[number]["key"];
