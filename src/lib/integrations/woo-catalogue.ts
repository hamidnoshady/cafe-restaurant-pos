/**
 * Phase 38 — WooCommerce's product model, as rules rather than as `if`s
 * scattered through the sync.
 *
 * Why this file exists: WooCommerce has never had one kind of product, and
 * "the product" is not always "the thing you can sell". A `variable` product
 * is a shell whose variations carry the SKU, the price and the stock; a
 * `grouped` product is a shelf of other people's products; an `external`
 * product has a price and a link and no stock at all. Every one of the three
 * ways a product reaches this app — the REST pull, the webhook, the plugin
 * push — used to make its own ad-hoc decision about that, and they did not
 * agree:
 *
 *   - the REST pull never saw a variation (they are not in `/products`), so
 *     nothing was ever mapped;
 *   - an order line's `variation_id` was ignored, so a variation line
 *     resolved to its parent — which is deliberately created as a
 *     non-sellable `variant_parent` with no stock row, so the sale recorded
 *     revenue and dropped the COGS;
 *   - the plugin sent `product_id` = the variation (because
 *     `WC_Order_Item_Product::get_product()` returns the variation when there
 *     is one) while a webhook sends `product_id` = parent plus
 *     `variation_id` = child, so the same order resolved to two different
 *     items depending on how the store was connected.
 *
 * Everything here is pure: no database, no `fetch`, no `Date.now()`. That is
 * what lets the rules be tested against a whole matrix of product shapes
 * instead of against whichever one a live store happened to have.
 */

import type { WooOrderLineItem, WooProduct, WooVariationAttribute } from "./woocommerce-client";

/** WooCommerce product types this app has an answer for. */
export type WooProductFamily =
  | "simple"
  | "variable"
  | "variation"
  | "grouped"
  | "external"
  | "bundle"
  | "composite"
  | "subscription"
  | "unknown";

/**
 * What one product type means for us.
 *
 * `sellable` is the question the order import actually asks: may a line item
 * point at this remote id and expect stock relief and COGS? It is false for
 * `variable` and `grouped` for *different* reasons — a variable product's
 * children are its own rows, a grouped product's children are ordinary
 * products that stand alone — and the difference shows up in `container`.
 */
export interface WooProductShape {
  family: WooProductFamily;
  /** A line item may resolve to this remote id and relieve stock. */
  sellable: boolean;
  /** This product exists to hold others (`variable`, `grouped`). */
  container: boolean;
  /** The store tracks stock for it. False for `external` — sold elsewhere. */
  stockTracked: boolean;
  /** The retail `items.kind` this becomes. F&B has no parent/child model. */
  itemKind: "simple" | "variant_parent" | "variant_child";
}

const SIMPLE: WooProductShape = {
  family: "simple",
  sellable: true,
  container: false,
  stockTracked: true,
  itemKind: "simple",
};

const SHAPES: Record<WooProductFamily, WooProductShape> = {
  simple: SIMPLE,
  variable: {
    family: "variable",
    sellable: false,
    container: true,
    stockTracked: false,
    itemKind: "variant_parent",
  },
  variation: {
    family: "variation",
    sellable: true,
    container: false,
    stockTracked: true,
    itemKind: "variant_child",
  },
  grouped: {
    // A grouped product is a display shelf: it has no price of its own and
    // its children are ordinary products that are also sold on their own.
    // So it is a container, but unlike `variable` its children are NOT
    // re-parented — a product can sit on two shelves at once.
    family: "grouped",
    sellable: false,
    container: true,
    stockTracked: false,
    itemKind: "variant_parent",
  },
  external: {
    // An affiliate listing: a price and a URL, sold on someone else's site.
    // Recording it keeps the catalogue complete and the revenue honest;
    // pretending it has stock would invent inventory that does not exist.
    family: "external",
    sellable: true,
    container: false,
    stockTracked: false,
    itemKind: "simple",
  },
  // Bundles and composites are sold as a unit at the parent's price. Woo
  // relieves their children's stock itself when configured to, and there is
  // no way to know from the REST payload which of the two strategies a given
  // store picked — so they are treated as ordinary sellable products here and
  // the store stays authoritative about its own stock.
  bundle: { ...SIMPLE, family: "bundle" },
  composite: { ...SIMPLE, family: "composite" },
  subscription: { ...SIMPLE, family: "subscription" },
  // An unrecognised type is a type we have not caught up with, not a product
  // to skip. Defaulting to `simple` means a shop running a product type from
  // an extension still gets a sellable item with a price, which is closer to
  // right than silently dropping it from the catalogue.
  unknown: { ...SIMPLE, family: "unknown" },
};

/**
 * WooCommerce's own type strings, including the ones the popular extensions
 * add. Lower-cased before lookup, because WooCommerce is not consistent
 * about case across REST versions.
 */
const TYPE_ALIASES: Record<string, WooProductFamily> = {
  simple: "simple",
  variable: "variable",
  variation: "variation",
  grouped: "grouped",
  external: "external",
  affiliate: "external",
  bundle: "bundle",
  yith_bundle: "bundle",
  composite: "composite",
  subscription: "subscription",
  "variable-subscription": "variable",
  "subscription_variation": "variation",
  simple_subscription: "subscription",
};

export function classifyWooProductType(type: string | undefined | null): WooProductFamily {
  if (!type) return "unknown";
  const key = type.trim().toLowerCase();
  if (key in TYPE_ALIASES) return TYPE_ALIASES[key];
  // `woosb`, `pw-gift-card`, `job_package` … — anything unrecognised.
  return "unknown";
}

export function wooProductShape(type: string | undefined | null): WooProductShape {
  return SHAPES[classifyWooProductType(type)];
}

/**
 * A product's type, inferred from its shape when the type is missing.
 *
 * The REST API always sends `type`, but a webhook payload for a variation
 * sometimes does not, and a plugin-built payload cannot always be trusted to
 * have it. A product with a `parent_id` is a variation — that is the one
 * inference that is always safe.
 */
export function inferWooProductType(product: {
  type?: string;
  parent_id?: number | null;
}): WooProductFamily {
  const declared = classifyWooProductType(product.type);
  if (declared !== "unknown") return declared;
  if (product.parent_id) return "variation";
  return "unknown";
}

export function isSellableWooProduct(product: { type?: string; parent_id?: number | null }): boolean {
  return wooProductShape(inferWooProductType(product)).sellable;
}

// ---------------------------------------------------------------------------
// Order lines
// ---------------------------------------------------------------------------

/**
 * How one order line resolved to a remote product id.
 *
 * Returned rather than just the id because the caller's behaviour differs:
 * a `variation` line that resolves is stock-relieved, a `parent_fallback`
 * line is recorded without stock (the variation was never synced), and an
 * `unmapped` line is recorded with nothing at all. Collapsing those into one
 * nullable id is how the old code lost the difference.
 */
export type WooLineResolution =
  | { remoteId: string; via: "variation"; variationId: number; productId: number }
  | { remoteId: string; via: "product"; productId: number }
  /** A variation line whose variation is not mapped — fall back to its parent. */
  | { remoteId: string; via: "parent_fallback"; variationId: number; productId: number }
  | { remoteId: null; via: "none" };

/**
 * Which remote id an order line is really about.
 *
 * `variation_id` wins whenever WooCommerce sent a non-zero one — that is the
 * sellable unit, and it is the only id whose `integration_mappings` row
 * points at a row with stock. `product_id` is the fallback for simple
 * products and for the plugin's older payloads.
 *
 * A zero/absent variation id on a line whose product_id is a *variable*
 * parent is deliberately not turned into an error: it means the store sold
 * something this app cannot narrow down, and the honest outcome is a recorded
 * line with no stock movement, not a failed import.
 */
export function resolveWooOrderLine(line: WooOrderLineItem): WooLineResolution {
  const productId = Number(line.product_id ?? 0) || 0;
  const variationId = Number(line.variation_id ?? 0) || 0;
  // A store that repeats the product id in variation_id is not pointing at a
  // variation; treating it as one would make the caller look for a child
  // mapping that cannot exist.
  if (variationId > 0 && variationId !== productId) {
    return { remoteId: String(variationId), via: "variation", variationId, productId };
  }
  if (productId > 0) return { remoteId: String(productId), via: "product", productId };
  return { remoteId: null, via: "none" };
}

/** The ids a line could resolve to, in priority order, deduped. */
export function wooLineCandidateIds(line: WooOrderLineItem): string[] {
  const productId = Number(line.product_id ?? 0) || 0;
  const variationId = Number(line.variation_id ?? 0) || 0;
  const ids: string[] = [];
  if (variationId > 0) ids.push(String(variationId));
  if (productId > 0 && productId !== variationId) ids.push(String(productId));
  return ids;
}

/**
 * The id to fall back to when a variation line's variation is not mapped:
 * the variation's parent, if the line carries one.
 */
export function wooLineParentFallback(line: WooOrderLineItem): string | null {
  const productId = Number(line.product_id ?? 0) || 0;
  const variationId = Number(line.variation_id ?? 0) || 0;
  if (variationId > 0 && productId > 0 && productId !== variationId) return String(productId);
  return null;
}

// ---------------------------------------------------------------------------
// Names — "T-shirt" is not enough when the store sells twelve of them
// ---------------------------------------------------------------------------

/**
 * `[{name:'رنگ', option:'قرمز'}]` → «رنگ: قرمز».
 *
 * Empty when either half is missing: an attribute with a name and no value
 * renders as a bare «رنگ» hanging off the end of a product name, which reads
 * like a truncated string rather than like a variation.
 */
export function formatWooVariationAttribute(attribute: WooVariationAttribute): string {
  const name = attribute.name?.trim() ?? "";
  const value = attribute.option?.trim() ?? "";
  if (!name || !value) return "";
  return `${name}: ${value}`;
}

/**
 * A variation's display name: the parent's name plus its attributes.
 *
 * WooCommerce's own REST payload already puts this in `name` for
 * order lines but not for the variation resource, and the app's item list
 * shows rows with no parent beside them — «تی‌شرت» three times, with nothing
 * to tell them apart.
 */
export function wooVariationDisplayName(
  parentName: string,
  attributes: WooVariationAttribute[] | undefined,
): string {
  const base = parentName.trim();
  const parts = (attributes ?? []).map(formatWooVariationAttribute).filter(Boolean);
  if (parts.length === 0) return base;
  return `${base} • ${parts.join("، ")}`;
}

/** The `attribute_pa_colour` / `attribute_size` keys WooCommerce uses internally. */
const ATTRIBUTE_PREFIX = /^attribute_/i;

/** `attribute_pa_colour` → «pa_colour»; anything else unchanged. */
export function wooAttributeSlug(key: string): string {
  return key.replace(ATTRIBUTE_PREFIX, "");
}

/**
 * A variation's attributes as `{name, option}` pairs, from either shape.
 *
 * The REST resource sends `attributes: [{id, name, option}]`. A raw
 * WooCommerce webhook for an order line sends `meta_data`. The plugin
 * normalises to the first form, but a payload built by anything else must
 * still work, so both are read here.
 */
export function wooVariationAttributes(product: {
  variation_attributes?: WooVariationAttribute[];
  attributes?: { name?: string; option?: string }[];
  meta_data?: { key?: string; value?: unknown }[];
}): WooVariationAttribute[] {
  if (product.variation_attributes?.length) {
    return product.variation_attributes
      .map((a) => ({ name: a.name, option: a.option }))
      .filter((a) => a.name && a.option);
  }
  const fromAttributes = (product.attributes ?? [])
    .map((a) => ({ name: a.name?.trim() ?? "", option: a.option?.trim() ?? "" }))
    .filter((a) => a.name && a.option);
  if (fromAttributes.length) return fromAttributes;

  return (product.meta_data ?? [])
    .filter((m) => typeof m.key === "string" && ATTRIBUTE_PREFIX.test(m.key))
    .map((m) => ({
      name: wooAttributeSlug(m.key as string),
      option: String(m.value ?? "").trim(),
    }))
    .filter((a) => a.name && a.option);
}

// ---------------------------------------------------------------------------
// Taxonomies
// ---------------------------------------------------------------------------

/** The taxonomies every WooCommerce store has, in the order worth showing. */
export const WOO_CORE_TAXONOMIES = ["product_cat", "product_tag"] as const;

/** Persian labels for the taxonomy slugs an owner will actually see. */
export const WOO_TAXONOMY_LABELS: Record<string, string> = {
  product_cat: "دسته‌بندی‌ها",
  product_tag: "برچسب‌ها",
};

/** `pa_colour` → «ویژگی: colour»; a custom taxonomy falls back to its slug. */
export function wooTaxonomyLabel(taxonomy: string): string {
  if (WOO_TAXONOMY_LABELS[taxonomy]) return WOO_TAXONOMY_LABELS[taxonomy];
  if (taxonomy.startsWith("pa_")) return `ویژگی: ${taxonomy.slice(3)}`;
  return taxonomy;
}

/** True for `pa_*`: an attribute taxonomy whose terms make variations distinct. */
export function isWooAttributeTaxonomy(taxonomy: string): boolean {
  return /^pa_/i.test(taxonomy);
}

export interface WooTermLike {
  remoteId: string;
  parentRemoteId?: string | null;
  name: string;
  slug?: string;
}

/**
 * «men › shirts › tees» — a term's path through its tree.
 *
 * Cycle-guarded: a store that has managed to make a term its own
 * grandparent (it happens after a bad import) would otherwise hang the
 * renderer that draws the tree.
 */
export function wooTermPath(term: WooTermLike, byId: Map<string, WooTermLike>): string {
  const names: string[] = [term.name];
  const seen = new Set<string>([term.remoteId]);
  let cursor = term.parentRemoteId ?? null;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (!parent) break;
    names.unshift(parent.name);
    cursor = parent.parentRemoteId ?? null;
  }
  return names.filter(Boolean).join(" › ");
}

/**
 * Sort terms into tree order — parents before children, siblings by
 * `menu_order` then name — so a flat list renders as a tree without a
 * recursive component.
 */
export function sortWooTerms<T extends WooTermLike & { menuOrder?: number }>(terms: T[]): T[] {
  const byId = new Map(terms.map((t) => [t.remoteId, t]));
  const depthOf = (term: T): number => {
    let depth = 0;
    const seen = new Set<string>([term.remoteId]);
    let cursor = term.parentRemoteId ?? null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = byId.get(cursor);
      if (!parent) break;
      depth += 1;
      cursor = parent.parentRemoteId ?? null;
    }
    return depth;
  };
  return [...terms].sort((a, b) => {
    const depth = depthOf(a) - depthOf(b);
    if (depth !== 0) return depth;
    const order = (a.menuOrder ?? 0) - (b.menuOrder ?? 0);
    if (order !== 0) return order;
    return a.name.localeCompare(b.name, "fa");
  });
}

// ---------------------------------------------------------------------------
// Catalogue sync planning
// ---------------------------------------------------------------------------

/**
 * Split a page of products into the order they must be written in.
 *
 * A variation whose parent has not been inserted yet cannot be created —
 * `items.parent_item_id` is a NOT NULL requirement of `variant_child`. The
 * old sync discovered this one product at a time, threw
 * `parent_variant_not_found`, logged it, and moved on, so a page that
 * happened to list a variation before its parent lost it until the next run.
 * Two passes over the whole batch makes the ordering a property of the batch
 * rather than of the store's pagination.
 */
export function planWooCatalogueWrite<T extends { id: number; type?: string; parent_id?: number | null }>(
  products: T[],
): { containers: T[]; sellables: T[]; skipped: T[] } {
  const containers: T[] = [];
  const sellables: T[] = [];
  const skipped: T[] = [];
  const containerIds = new Set<string>();

  for (const product of products) {
    const shape = wooProductShape(inferWooProductType(product));
    if (shape.container) {
      containers.push(product);
      containerIds.add(String(product.id));
      continue;
    }
    if (shape.sellable) {
      sellables.push(product);
      continue;
    }
    // Nothing is unclassifiable now (`unknown` is sellable), but a future
    // shape that is neither must be reported rather than dropped silently.
    skipped.push(product);
  }

  // Variations whose parent is in this same batch wait for pass 2; the rest
  // are written in pass 1 with the containers, because their parent already
  // exists locally (or they have none).
  const deferred: T[] = [];
  const immediate: T[] = [];
  for (const product of sellables) {
    const shape = wooProductShape(inferWooProductType(product));
    if (shape.itemKind === "variant_child" && product.parent_id && containerIds.has(String(product.parent_id))) {
      deferred.push(product);
    } else {
      immediate.push(product);
    }
  }

  return { containers: [...containers, ...immediate], sellables: deferred, skipped };
}

/**
 * Which of a product's remote ids the app should keep a mapping for.
 *
 * A variable parent needs one (order lines for an unmapped variation fall
 * back to it), and so does every variation. A `grouped` product gets one for
 * itself for the same fallback reason even though it is not sellable.
 */
export function wooProductRemoteIds(product: WooProduct): string[] {
  return [String(product.id)];
}

/**
 * The REST path a remote id's updates go to.
 *
 * A variation is not `products/{id}`. It is
 * `products/{parent}/variations/{id}`, and calling the former with a
 * variation id is a 404 that the old outbox retried six times and then
 * dead-lettered — which is why pushing stock to a variation never worked.
 */
export function wooUpdatePath(remoteId: string, parentRemoteId?: string | null): string {
  if (parentRemoteId) return `products/${parentRemoteId}/variations/${remoteId}`;
  return `products/${remoteId}`;
}
