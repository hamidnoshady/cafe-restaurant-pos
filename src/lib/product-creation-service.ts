/**
 * Atomic write path for the retail products workspace.
 *
 * A product can span a container item, many sellable variant items, attribute
 * rows, scanner barcodes and opening stock/price rows. They are one user action
 * and therefore one transaction: a duplicate barcode or bad stock row must not
 * leave a half-created family in the catalogue.
 */
import Decimal from "decimal.js";
import { getPool, type PoolClient } from "./db";
import { setInitialUnitCost, receiveStock, setUnitPrice } from "./accessories-service";
import { assignBarcode } from "./item-barcodes-service";
import {
  createItem,
  createVariantChild,
  updateItemMeta,
  type Item,
  type ItemMetaPatch,
} from "./items-service";
import type { ParsedProductCreateInput, ParsedProductVariantInput } from "./product-input";

export interface CreatedProduct {
  item: Item;
  variants: Item[];
}

function commonMeta(input: ParsedProductCreateInput): ItemMetaPatch {
  return {
    unit: input.unit,
    subUnit: input.subUnit,
    conversionFactor: input.conversionFactor,
    minOrderQty: input.minOrderQty,
    reorderReminderQty: input.reorderReminderQty,
    leadTimeDays: input.leadTimeDays,
    storageLocation: input.storageLocation,
    taxSalePercent: input.taxSalePercent,
    taxPurchasePercent: input.taxPurchasePercent,
    isSellable: input.isSellable,
  };
}

async function writeOpeningValues(
  client: PoolClient,
  itemId: string,
  defaults: Pick<ParsedProductCreateInput, "sellPrice" | "purchasePrice" | "quantity">,
  override?: ParsedProductVariantInput,
): Promise<void> {
  const sellPrice = override?.sellPrice ?? defaults.sellPrice;
  const purchasePrice = override?.purchasePrice ?? defaults.purchasePrice;
  const quantity = override?.quantity ?? defaults.quantity;

  if (sellPrice !== null) await setUnitPrice(itemId, sellPrice, client);

  if (quantity !== null && new Decimal(quantity).gt(0)) {
    await receiveStock(
      itemId,
      { quantity, unitCost: purchasePrice ?? 0 },
      client,
    );
  } else if (purchasePrice !== null) {
    // A known purchase price with no opening quantity is useful in the price
    // list, but is not a stock receipt (the old path attempted a zero-quantity
    // receipt, failed validation and left the already-created item behind).
    await setInitialUnitCost(itemId, purchasePrice, client);
  }
}

/** Create one validated product family, all-or-nothing. */
export async function createProductRecord(
  locationId: string,
  input: ParsedProductCreateInput,
): Promise<CreatedProduct> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");

    const hasVariants = input.variants.length > 0;
    const parent = await createItem(
      {
        locationId,
        name: input.name,
        sku: input.sku,
        kind: hasVariants ? "variant_parent" : "simple",
      },
      client,
    );
    await updateItemMeta(
      parent.id,
      {
        ...commonMeta(input),
        // A family is not the thing at the till. The parser also refuses a
        // parent barcode when variants exist, keeping scanner identity on the
        // actual sellable row.
        barcode: hasVariants ? null : input.barcode,
      },
      client,
    );

    const variants: Item[] = [];
    if (!hasVariants) {
      if (input.barcode) await assignBarcode(parent.id, { code: input.barcode }, client);
      await writeOpeningValues(client, parent.id, input);
    } else {
      for (const variant of input.variants) {
        const childName =
          variant.name ?? [input.name, ...variant.attributes.map((attribute) => attribute.value)].join(" — ");
        const child = await createVariantChild(
          parent.id,
          locationId,
          childName,
          variant.sku,
          variant.attributes,
          client,
        );
        await updateItemMeta(
          child.id,
          {
            ...commonMeta(input),
            barcode: variant.barcode,
          },
          client,
        );
        if (variant.barcode) await assignBarcode(child.id, { code: variant.barcode }, client);
        await writeOpeningValues(client, child.id, input, variant);
        variants.push(child);
      }
    }

    await client.query("COMMIT");
    return { item: parent, variants };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
