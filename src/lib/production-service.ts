/**
 * In-house production: formulas, runs, and the reversal of a run (Phase 29).
 *
 * A production run is a source document with exact-costing and ledger effects,
 * so it is never mutated in place. Correction is modelled the way the
 * stock-count, write-down and transfer workflows model it: a reversal document
 * that undoes the original at its own recorded value, with `reversal_of` on
 * `production_runs` marking the reversal row and the original
 * `inventory_events` row flipped to `posting_status = 'reversed'`.
 *
 * Two reversals are refused rather than silently mis-accounted, both for the
 * same reason the count workflow refuses its equivalents: some of the batch is
 * already gone. If the run's own output has been sold (`production_output_consumed`)
 * or an input's shortage layer has since been settled by a later receipt
 * (`consumption_layer_settled`, raised by reverseConsumedInventory), unwinding
 * bit-exactly would mean re-costing sales that have already been posted.
 *
 * DB-touching, so not unit-tested directly (repo convention) — the arithmetic
 * lives in production.ts and is what production.test.ts covers, and the
 * behaviour is covered by integration/production-runs.integration.test.ts.
 */
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import { query } from "./db";
import { consumeInventoryExact } from "./inventory-consumption-exact";
import {
  positiveQuantityText,
  quantityText,
  rialBigInt,
  rialText,
  type QuantityText,
  type RialText,
} from "./inventory-exact";
import { reverseConsumedInventory } from "./inventory-reversal";
import { isLotBased, type CostingMethod } from "./inventory-costing";
import { getCostingMethod } from "./inventory-service";
import { postExactNegativeSettlementEntry } from "./ledger-service";
import { emitDomainEvent } from "./posting-engine";
import { applyProductionOutputCosting } from "./production-output-costing";
import {
  formulaWouldCycle,
  scaleConversionCost,
  scaleFormulaInputs,
  scaleOutputQuantity,
  totalProductionCost,
} from "./production";
// Side-effect import: registers the six `production.*` rules with the engine.
import "./production-posting-rules";

export class ProductionError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "ProductionError";
  }
}

export interface ProductionFormulaInputRow {
  inventoryItemId: string;
  itemName: string;
  unit: string;
  quantity: string;
  /** The item's running average cost, so the UI can price the formula without a second round trip. */
  avgCost: string;
}

export interface ProductionFormulaRow {
  id: string;
  name: string;
  outputInventoryItemId: string;
  outputItemName: string;
  outputUnit: string;
  outputQuantity: string;
  conversionCostRial: string;
  notes: string | null;
  isActive: boolean;
  inputs: ProductionFormulaInputRow[];
}

export interface ProductionRunRow {
  id: string;
  formulaId: string;
  formulaName: string;
  outputInventoryItemId: string;
  outputItemName: string;
  outputUnit: string;
  batches: string;
  expectedQuantity: string;
  outputQuantity: string;
  materialCostRial: string;
  conversionCostRial: string;
  totalCostRial: string;
  unitCostRial: string;
  note: string | null;
  producedAt: string;
  producedByName: string | null;
  isReversal: boolean;
  /** Set once this run has been reversed, so the UI can hide the button rather than fail the call. */
  reversedByRunId: string | null;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listFormulas(locationId: string): Promise<ProductionFormulaRow[]> {
  const [{ rows: formulas }, { rows: inputs }] = await Promise.all([
    query<{
      id: string;
      name: string;
      output_inventory_item_id: string;
      output_item_name: string;
      output_unit: string;
      output_quantity: string;
      conversion_cost_rial: string;
      notes: string | null;
      is_active: boolean;
    }>(
      `SELECT f.id, f.name, f.output_inventory_item_id, oi.name AS output_item_name, oi.unit AS output_unit,
              f.output_quantity::text, f.conversion_cost_rial::text, f.notes, f.is_active
         FROM production_formulas f
         JOIN inventory_items oi ON oi.id = f.output_inventory_item_id
        WHERE f.location_id = $1
        ORDER BY f.name`,
      [locationId],
    ),
    query<{
      formula_id: string;
      inventory_item_id: string;
      item_name: string;
      unit: string;
      quantity: string;
      avg_cost: string;
    }>(
      `SELECT i.formula_id, i.inventory_item_id, ii.name AS item_name, ii.unit,
              i.quantity::text, ii.avg_cost::text
         FROM production_formula_inputs i
         JOIN production_formulas f ON f.id = i.formula_id
         JOIN inventory_items ii ON ii.id = i.inventory_item_id
        WHERE f.location_id = $1
        ORDER BY ii.name`,
      [locationId],
    ),
  ]);

  const inputsByFormula = new Map<string, ProductionFormulaInputRow[]>();
  for (const row of inputs) {
    const list = inputsByFormula.get(row.formula_id) ?? [];
    list.push({
      inventoryItemId: row.inventory_item_id,
      itemName: row.item_name,
      unit: row.unit,
      quantity: row.quantity,
      avgCost: row.avg_cost,
    });
    inputsByFormula.set(row.formula_id, list);
  }

  return formulas.map((f) => ({
    id: f.id,
    name: f.name,
    outputInventoryItemId: f.output_inventory_item_id,
    outputItemName: f.output_item_name,
    outputUnit: f.output_unit,
    outputQuantity: f.output_quantity,
    conversionCostRial: f.conversion_cost_rial,
    notes: f.notes,
    isActive: f.is_active,
    inputs: inputsByFormula.get(f.id) ?? [],
  }));
}

export async function listRuns(locationId: string, limit = 100): Promise<ProductionRunRow[]> {
  const { rows } = await query<{
    id: string;
    formula_id: string;
    formula_name: string;
    output_inventory_item_id: string;
    output_item_name: string;
    output_unit: string;
    batches: string;
    expected_quantity: string;
    output_quantity: string;
    material_cost_rial: string;
    conversion_cost_rial: string;
    total_cost_rial: string;
    note: string | null;
    produced_at: string;
    produced_by_name: string | null;
    is_reversal: boolean;
    reversed_by_run_id: string | null;
  }>(
    `SELECT r.id, r.formula_id, f.name AS formula_name,
            r.output_inventory_item_id, oi.name AS output_item_name, oi.unit AS output_unit,
            r.batches::text, (f.output_quantity * r.batches)::text AS expected_quantity,
            r.output_quantity::text, r.material_cost_rial::text, r.conversion_cost_rial::text,
            r.total_cost_rial::text, r.note, r.produced_at, u.full_name AS produced_by_name,
            (r.reversal_of IS NOT NULL) AS is_reversal,
            rev.id AS reversed_by_run_id
       FROM production_runs r
       JOIN production_formulas f ON f.id = r.formula_id
       JOIN inventory_items oi ON oi.id = r.output_inventory_item_id
       LEFT JOIN users u ON u.id = r.produced_by
       LEFT JOIN production_runs rev ON rev.reversal_of = r.id
      WHERE r.location_id = $1
      ORDER BY r.produced_at DESC, r.id DESC
      LIMIT $2`,
    [locationId, limit],
  );

  return rows.map((r) => ({
    id: r.id,
    formulaId: r.formula_id,
    formulaName: r.formula_name,
    outputInventoryItemId: r.output_inventory_item_id,
    outputItemName: r.output_item_name,
    outputUnit: r.output_unit,
    batches: r.batches,
    expectedQuantity: r.expected_quantity,
    outputQuantity: r.output_quantity,
    materialCostRial: r.material_cost_rial,
    conversionCostRial: r.conversion_cost_rial,
    totalCostRial: r.total_cost_rial,
    unitCostRial: new Decimal(r.total_cost_rial)
      .div(new Decimal(r.output_quantity))
      .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
      .toFixed(),
    note: r.note,
    producedAt: r.produced_at,
    producedByName: r.produced_by_name,
    isReversal: r.is_reversal,
    reversedByRunId: r.reversed_by_run_id,
  }));
}

// ---------------------------------------------------------------------------
// Formula writes
// ---------------------------------------------------------------------------

/**
 * Every produced item at this branch mapped to the inputs of the formula that
 * makes it — the graph `formulaWouldCycle` walks. `excludeFormulaId` drops the
 * formula being edited, so re-saving one does not see its own current inputs as
 * an existing constraint.
 */
async function producedByGraph(locationId: string, excludeFormulaId?: string): Promise<Map<string, string[]>> {
  const { rows } = await query<{ output_inventory_item_id: string; inventory_item_id: string }>(
    `SELECT f.output_inventory_item_id, i.inventory_item_id
       FROM production_formulas f
       JOIN production_formula_inputs i ON i.formula_id = f.id
      WHERE f.location_id = $1 AND ($2::uuid IS NULL OR f.id <> $2)`,
    [locationId, excludeFormulaId ?? null],
  );
  const graph = new Map<string, string[]>();
  for (const row of rows) {
    const list = graph.get(row.output_inventory_item_id) ?? [];
    list.push(row.inventory_item_id);
    graph.set(row.output_inventory_item_id, list);
  }
  return graph;
}

export async function createFormula(params: {
  businessId: string;
  locationId: string;
  name: string;
  outputInventoryItemId: string;
  outputQuantity: QuantityText;
  conversionCostRial: RialText;
  notes: string | null;
  createdBy: string | null;
}): Promise<{ id: string }> {
  const { rows: owned } = await query(
    "SELECT 1 FROM inventory_items WHERE id = $1 AND location_id = $2",
    [params.outputInventoryItemId, params.locationId],
  );
  if (owned.length === 0) throw new ProductionError("output_item_not_found");

  const { rows: duplicate } = await query(
    "SELECT 1 FROM production_formulas WHERE location_id = $1 AND name = $2",
    [params.locationId, params.name],
  );
  if (duplicate.length > 0) throw new ProductionError("formula_name_taken");

  const { rows } = await query<{ id: string }>(
    `INSERT INTO production_formulas
       (business_id, location_id, name, output_inventory_item_id, output_quantity, conversion_cost_rial, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      params.businessId,
      params.locationId,
      params.name,
      params.outputInventoryItemId,
      params.outputQuantity,
      params.conversionCostRial,
      params.notes,
      params.createdBy,
    ],
  );

  // A formula's output is by definition made in-house, so mark it. Descriptive
  // only — it drives the UI's pickers and the production report, and does not
  // stop the same item also being bought ready-made.
  await query("UPDATE inventory_items SET is_produced = true WHERE id = $1", [params.outputInventoryItemId]);
  return { id: rows[0].id };
}

export async function updateFormula(params: {
  locationId: string;
  formulaId: string;
  name?: string;
  outputQuantity?: QuantityText;
  conversionCostRial?: RialText;
  notes?: string | null;
  isActive?: boolean;
}): Promise<void> {
  const fields: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown) => {
    values.push(value);
    fields.push(`${column} = $${values.length + 2}`);
  };
  if (params.name !== undefined) set("name", params.name);
  if (params.outputQuantity !== undefined) set("output_quantity", params.outputQuantity);
  if (params.conversionCostRial !== undefined) set("conversion_cost_rial", params.conversionCostRial);
  if (params.notes !== undefined) set("notes", params.notes);
  if (params.isActive !== undefined) set("is_active", params.isActive);
  if (fields.length === 0) throw new ProductionError("bad_request");

  const { rowCount } = await query(
    `UPDATE production_formulas SET ${fields.join(", ")}, updated_at = now()
      WHERE id = $1 AND location_id = $2`,
    [params.formulaId, params.locationId, ...values],
  );
  if (rowCount === 0) throw new ProductionError("formula_not_found");
}

/**
 * Deletes a formula, or deactivates it when a run already references it — the
 * same posture `/api/inventory/items/[id]` takes towards an item with history.
 * A posted run must keep pointing at the formula it was made from.
 */
export async function deleteFormula(locationId: string, formulaId: string): Promise<{ deactivated: boolean }> {
  const { rows: owned } = await query("SELECT 1 FROM production_formulas WHERE id = $1 AND location_id = $2", [
    formulaId,
    locationId,
  ]);
  if (owned.length === 0) throw new ProductionError("formula_not_found");

  const { rows: runs } = await query("SELECT 1 FROM production_runs WHERE formula_id = $1 LIMIT 1", [formulaId]);
  if (runs.length > 0) {
    await query("UPDATE production_formulas SET is_active = false, updated_at = now() WHERE id = $1", [formulaId]);
    return { deactivated: true };
  }
  await query("DELETE FROM production_formulas WHERE id = $1", [formulaId]);
  return { deactivated: false };
}

export async function setFormulaInput(params: {
  locationId: string;
  formulaId: string;
  inventoryItemId: string;
  quantity: QuantityText;
}): Promise<void> {
  const { rows: owned } = await query<{ output_inventory_item_id: string }>(
    `SELECT f.output_inventory_item_id
       FROM production_formulas f
      WHERE f.id = $1 AND f.location_id = $2
        AND EXISTS (SELECT 1 FROM inventory_items WHERE id = $3 AND location_id = $2)`,
    [params.formulaId, params.locationId, params.inventoryItemId],
  );
  if (owned.length === 0) throw new ProductionError("formula_not_found");

  const graph = await producedByGraph(params.locationId, params.formulaId);
  const { rows: existing } = await query<{ inventory_item_id: string }>(
    "SELECT inventory_item_id FROM production_formula_inputs WHERE formula_id = $1",
    [params.formulaId],
  );
  const inputIds = [...new Set([...existing.map((r) => r.inventory_item_id), params.inventoryItemId])];
  if (formulaWouldCycle(owned[0].output_inventory_item_id, inputIds, graph)) {
    throw new ProductionError("formula_cycle");
  }

  await query(
    `INSERT INTO production_formula_inputs (formula_id, inventory_item_id, quantity)
     VALUES ($1,$2,$3)
     ON CONFLICT (formula_id, inventory_item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
    [params.formulaId, params.inventoryItemId, params.quantity],
  );
}

export async function deleteFormulaInput(params: {
  locationId: string;
  formulaId: string;
  inventoryItemId: string;
}): Promise<void> {
  await query(
    `DELETE FROM production_formula_inputs
      WHERE formula_id = $1 AND inventory_item_id = $2
        AND formula_id IN (SELECT id FROM production_formulas WHERE location_id = $3)`,
    [params.formulaId, params.inventoryItemId, params.locationId],
  );
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/**
 * Acquires the row locks for every inventory item a run touches, in ascending
 * id order.
 *
 * Deliberately done up front and in one statement rather than item by item as
 * the work proceeds: the sale, purchase-receipt, count and reversal paths all
 * lock in this order, so taking them any other way is how a production run
 * would deadlock against a till taking money.
 */
async function lockItems(client: PoolClient, itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  await client.query("SELECT id FROM inventory_items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [
    [...new Set(itemIds)].sort(),
  ]);
}

export interface RecordedProductionRun {
  id: string;
  materialCostRial: RialText;
  conversionCostRial: RialText;
  totalCostRial: RialText;
  unitCostRial: string;
  duplicate?: boolean;
}

/**
 * Records one batch: consumes the formula's inputs at their exact cost and
 * receipts the output at what they came to plus the conversion cost.
 *
 * Runs inside the caller's transaction. The inputs go out through the same
 * exact path a sale uses, so a raw material that has run short opens a *priced*
 * negative layer rather than a silently unpriced one; the output comes in
 * through applyProductionOutputCosting, which settles any shortage of the
 * produced item before putting the residual on the shelf.
 */
export async function recordProductionRun(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    formulaId: string;
    batches: QuantityText;
    /** actual yield; defaults to the formula's expected yield × batches */
    outputQuantity?: QuantityText | null;
    /** overrides the formula's default × batches when given */
    conversionCostRial?: RialText | null;
    note: string | null;
    createdBy: string | null;
    /** Caller-owned domain idempotency identity (for sync retries). */
    idempotencyKey?: string | null;
  },
): Promise<RecordedProductionRun> {
  const domainKey = params.idempotencyKey ? `production-sync:${params.idempotencyKey}` : null;
  if (domainKey) {
    const prior = await client.query<{
      id: string;
      material_cost_rial: string;
      conversion_cost_rial: string;
      total_cost_rial: string;
      output_quantity: string;
    }>(
      `SELECT id,material_cost_rial::text,conversion_cost_rial::text,total_cost_rial::text,output_quantity::text
         FROM production_runs WHERE business_id=$1 AND idempotency_key=$2`,
      [params.businessId, domainKey],
    );
    if (prior.rows[0]) {
      const row = prior.rows[0];
      return {
        id: row.id,
        materialCostRial: rialText(row.material_cost_rial),
        conversionCostRial: rialText(row.conversion_cost_rial),
        totalCostRial: rialText(row.total_cost_rial),
        unitCostRial: new Decimal(row.total_cost_rial).div(new Decimal(row.output_quantity)).toDecimalPlaces(9).toFixed(),
        duplicate: true,
      };
    }
  }
  const { rows: formulas } = await client.query<{
    id: string;
    output_inventory_item_id: string;
    output_quantity: string;
    conversion_cost_rial: string;
    is_active: boolean;
  }>(
    `SELECT id, output_inventory_item_id, output_quantity::text, conversion_cost_rial::text, is_active
       FROM production_formulas WHERE id = $1 AND location_id = $2`,
    [params.formulaId, params.locationId],
  );
  const formula = formulas[0];
  if (!formula) throw new ProductionError("formula_not_found");
  if (!formula.is_active) throw new ProductionError("formula_inactive");

  const { rows: inputRows } = await client.query<{ inventory_item_id: string; quantity: string }>(
    "SELECT inventory_item_id, quantity::text FROM production_formula_inputs WHERE formula_id = $1",
    [params.formulaId],
  );
  if (inputRows.length === 0) throw new ProductionError("formula_has_no_inputs");

  const scaled = scaleFormulaInputs(
    inputRows.map((r) => ({ inventoryItemId: r.inventory_item_id, quantity: quantityText(r.quantity) })),
    params.batches,
  );
  const expectedQuantity = scaleOutputQuantity(quantityText(formula.output_quantity), params.batches);
  const outputQuantity = positiveQuantityText(params.outputQuantity ?? expectedQuantity);
  const conversionCost =
    params.conversionCostRial ?? scaleConversionCost(rialText(formula.conversion_cost_rial), params.batches);

  await lockItems(client, [...scaled.map((s) => s.inventoryItemId), formula.output_inventory_item_id]);

  // The run's id is minted here rather than by the database so that both it and
  // the inventory event can carry an idempotency key derived from it in their
  // own INSERT — a retry of this transaction then collides on
  // `production_runs (business_id, idempotency_key)` instead of writing a
  // second batch.
  const runId = randomUUID();

  const { rows: events } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id, location_id, event_type, source_type, source_id, created_by, costing_version,
        idempotency_key, metadata)
     VALUES ($1,$2,'production','production',$3::uuid,$4,2,$6,
             jsonb_build_object('formulaId',$5::text))
     RETURNING id`,
    [params.businessId, params.locationId, runId, params.createdBy, params.formulaId,
      domainKey ? `inventory-event:${domainKey}` : `production-run:${runId}`],
  );
  const eventId = events[0].id;

  await client.query(
    `INSERT INTO production_runs
       (id, business_id, location_id, formula_id, output_inventory_item_id, batches, output_quantity,
        material_cost_rial, conversion_cost_rial, total_cost_rial, note, produced_by,
        inventory_event_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,$8,$9,$10,$11,$12)`,
    [
      runId,
      params.businessId,
      params.locationId,
      params.formulaId,
      formula.output_inventory_item_id,
      params.batches,
      outputQuantity,
      conversionCost,
      params.note,
      params.createdBy,
      eventId,
      domainKey ?? `production-run:${runId}`,
    ],
  );

  let materialCost = 0n;
  for (const input of scaled) {
    const consumed = await consumeInventoryExact(client, {
      locationId: params.locationId,
      businessId: params.businessId,
      inventoryItemId: input.inventoryItemId,
      quantity: input.quantity,
      type: "production_consume",
      sourceType: "production",
      sourceId: runId,
      createdBy: params.createdBy,
      inventoryEventId: eventId,
    });
    materialCost += rialBigInt(consumed.postedCost);
    await client.query(
      `INSERT INTO production_run_inputs (production_run_id, inventory_item_id, quantity, cost_rial)
       VALUES ($1,$2,$3,$4)`,
      [runId, input.inventoryItemId, input.quantity, consumed.postedCost],
    );
  }

  const materialCostText = rialText(materialCost.toString());
  const totalCost = totalProductionCost(materialCostText, conversionCost);
  await client.query(
    "UPDATE production_runs SET material_cost_rial = $2, total_cost_rial = $3 WHERE id = $1",
    [runId, materialCostText, totalCost],
  );

  const output = await applyProductionOutputCosting(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    inventoryItemId: formula.output_inventory_item_id,
    quantity: outputQuantity,
    totalValue: totalCost,
    productionRunId: runId,
    inventoryEventId: eventId,
    createdBy: params.createdBy,
  });

  await postRunEntries(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    runId,
    eventId,
    createdBy: params.createdBy,
    materialCost: materialCostText,
    conversionCost,
    totalCost,
    upward: output.upwardSettlementAdjustment,
    downward: output.downwardSettlementAdjustment,
    reversal: false,
  });

  await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [eventId]);

  return {
    id: runId,
    materialCostRial: materialCostText,
    conversionCostRial: conversionCost,
    totalCostRial: totalCost,
    unitCostRial: new Decimal(totalCost)
      .div(new Decimal(outputQuantity))
      .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
      .toFixed(),
  };
}

/** The event type for each leg of a run, and of a reversal of one. */
const RUN_EVENT_TYPES = {
  materials: "production.materials_issued",
  conversion: "production.conversion_absorbed",
  output: "production.output_received",
} as const;

const REVERSAL_EVENT_TYPES = {
  materials: "production.materials_issue_reversed",
  conversion: "production.conversion_absorption_reversed",
  output: "production.output_receipt_reversed",
} as const;

/** The three transformation entries, plus the settlement correction when the output closed a shortage. */
async function postRunEntries(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    runId: string;
    eventId: string;
    createdBy: string | null;
    materialCost: RialText;
    conversionCost: RialText;
    totalCost: RialText;
    upward: RialText;
    downward: RialText;
    reversal: boolean;
  },
): Promise<void> {
  const types = params.reversal ? REVERSAL_EVENT_TYPES : RUN_EVENT_TYPES;
  const legs: Array<[string, RialText]> = [
    [types.materials, params.materialCost],
    [types.conversion, params.conversionCost],
    [types.output, params.totalCost],
  ];

  for (const [eventType, amount] of legs) {
    await emitDomainEvent(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      eventType,
      payload: { amount, inventoryEventId: params.eventId },
      sourceType: "production",
      sourceId: params.runId,
      createdBy: params.createdBy,
    });
  }

  if (rialBigInt(params.upward) > 0n || rialBigInt(params.downward) > 0n) {
    await postExactNegativeSettlementEntry(client, {
      businessId: params.businessId,
      locationId: params.locationId,
      sourceType: "production",
      sourceId: params.runId,
      createdBy: params.createdBy,
      upward: params.upward,
      downward: params.downward,
      inventoryEventId: params.eventId,
    });
  }
}

/**
 * Undoes a posted run: takes the finished batch back off the shelf at what it
 * was receipted at, puts the materials back at what they cost, and mirrors the
 * three ledger entries.
 *
 * The output side is the surplus-reversal shape `reverseStockCount` uses — the
 * run's own FIFO lot must still be fully on hand, since a lot the till has
 * drawn on cannot be withdrawn without re-costing that sale. The input side is
 * `reverseConsumedInventory`, which already handles cancelling the negative
 * layers the consumption opened and refuses when a later receipt has settled
 * one.
 */
export async function reverseProductionRun(
  client: PoolClient,
  params: {
    businessId: string;
    locationId: string;
    runId: string;
    note: string | null;
    createdBy: string | null;
  },
): Promise<{ id: string }> {
  const { rows: runs } = await client.query<{
    id: string;
    formula_id: string;
    output_inventory_item_id: string;
    batches: string;
    output_quantity: string;
    material_cost_rial: string;
    conversion_cost_rial: string;
    total_cost_rial: string;
    inventory_event_id: string | null;
    produced_at: string;
  }>(
    `SELECT id, formula_id, output_inventory_item_id, batches::text, output_quantity::text,
            material_cost_rial::text, conversion_cost_rial::text, total_cost_rial::text,
            inventory_event_id, produced_at::text
       FROM production_runs
      WHERE id = $1 AND location_id = $2 AND reversal_of IS NULL
      FOR UPDATE`,
    [params.runId, params.locationId],
  );
  const run = runs[0];
  if (!run) throw new ProductionError("run_not_found");
  if (!run.inventory_event_id) throw new ProductionError("run_not_reversible");

  const { rows: already } = await client.query("SELECT 1 FROM production_runs WHERE reversal_of = $1 LIMIT 1", [
    params.runId,
  ]);
  if (already.length > 0) throw new ProductionError("already_reversed");

  const { rows: inputRows } = await client.query<{ inventory_item_id: string }>(
    "SELECT inventory_item_id FROM production_run_inputs WHERE production_run_id = $1",
    [params.runId],
  );
  await lockItems(client, [...inputRows.map((r) => r.inventory_item_id), run.output_inventory_item_id]);

  const method = await getCostingMethod(params.businessId, client);

  const reversalRunId = randomUUID();
  const { rows: reversalEvents } = await client.query<{ id: string }>(
    `INSERT INTO inventory_events
       (business_id, location_id, event_type, source_type, source_id, created_by, costing_version,
        idempotency_key, reversal_of)
     VALUES ($1,$2,'production_reversal','production',$3::uuid,$4,2,
             'production-reversal:' || $3::uuid::text,$5)
     RETURNING id`,
    [params.businessId, params.locationId, reversalRunId, params.createdBy, run.inventory_event_id],
  );
  const reversalEventId = reversalEvents[0].id;

  await client.query(
    `INSERT INTO production_runs
       (id, business_id, location_id, formula_id, output_inventory_item_id, batches, output_quantity,
        material_cost_rial, conversion_cost_rial, total_cost_rial, note, produced_by,
        reversal_of, inventory_event_id, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'production-run:' || $1::uuid::text)`,
    [
      reversalRunId,
      params.businessId,
      params.locationId,
      run.formula_id,
      run.output_inventory_item_id,
      run.batches,
      run.output_quantity,
      run.material_cost_rial,
      run.conversion_cost_rial,
      run.total_cost_rial,
      params.note,
      params.createdBy,
      params.runId,
      reversalEventId,
    ],
  );

  const settlement = await withdrawProductionOutput(client, {
    locationId: params.locationId,
    inventoryItemId: run.output_inventory_item_id,
    quantity: positiveQuantityText(run.output_quantity),
    value: BigInt(run.total_cost_rial),
    originalRunId: params.runId,
    originalEventId: run.inventory_event_id,
    reversalRunId,
    reversalEventId,
    createdBy: params.createdBy,
    method,
  });

  await reverseConsumedInventory(client, {
    locationId: params.locationId,
    consumptionEventId: run.inventory_event_id,
    movementType: "production_consume",
    sourceType: "production",
    sourceId: reversalRunId,
    reversalEventId,
    receivedAt: run.produced_at,
    createdBy: params.createdBy,
    method,
  });

  await postRunEntries(client, {
    businessId: params.businessId,
    locationId: params.locationId,
    runId: reversalRunId,
    eventId: reversalEventId,
    createdBy: params.createdBy,
    materialCost: rialText(run.material_cost_rial),
    conversionCost: rialText(run.conversion_cost_rial),
    totalCost: rialText(run.total_cost_rial),
    // The original settlement entry moved COGS ↔ inventory for the value
    // difference; the reversal swaps the two directions.
    upward: settlement.downward,
    downward: settlement.upward,
    reversal: true,
  });

  await client.query("UPDATE inventory_events SET posting_status = 'reversed' WHERE id = $1", [
    run.inventory_event_id,
  ]);
  await client.query("UPDATE inventory_events SET posting_status = 'posted' WHERE id = $1", [reversalEventId]);
  return { id: reversalRunId };
}

/**
 * Takes a run's output back out of stock at exactly what it went in at: first
 * re-opening the negative layers the run settled, then removing the residual
 * positive stock.
 *
 * Mirrors the surplus branch of stock-count-service's reverseAdjustmentLine.
 * The refusal is the important part — a FIFO lot that is no longer whole, or a
 * carrying value that no longer covers the batch, means part of what was made
 * has already been sold, and unwinding it would silently re-cost that sale.
 */
async function withdrawProductionOutput(
  client: PoolClient,
  params: {
    locationId: string;
    inventoryItemId: string;
    quantity: QuantityText;
    value: bigint;
    originalRunId: string;
    originalEventId: string;
    reversalRunId: string;
    reversalEventId: string;
    createdBy: string | null;
    method: CostingMethod;
  },
): Promise<{ upward: RialText; downward: RialText }> {
  let upward = 0n;
  let downward = 0n;

  const { rows: settlements } = await client.query<{
    id: string;
    negative_layer_id: string;
    quantity: string;
    provisional_value_rial: string;
    actual_value_rial: string;
  }>(
    `SELECT s.id, s.negative_layer_id, s.quantity::text, s.provisional_value_rial::text, s.actual_value_rial::text
       FROM inventory_negative_layer_settlements s
       JOIN inventory_negative_layers l ON l.id = s.negative_layer_id
      WHERE s.production_run_id = $1 AND l.inventory_item_id = $2
      ORDER BY s.id
      FOR UPDATE OF s`,
    [params.originalRunId, params.inventoryItemId],
  );
  let settledValue = 0n;
  for (const settlement of settlements) {
    const provisional = BigInt(settlement.provisional_value_rial);
    const actual = BigInt(settlement.actual_value_rial);
    const difference = actual - provisional;
    if (difference > 0n) upward += difference;
    else if (difference < 0n) downward += -difference;
    settledValue += actual;
    await client.query(
      `UPDATE inventory_negative_layers
          SET remaining_quantity = remaining_quantity + $2::numeric,
              remaining_provisional_value_rial = remaining_provisional_value_rial + $3::bigint,
              settled_at = NULL
        WHERE id = $1`,
      [settlement.negative_layer_id, settlement.quantity, settlement.provisional_value_rial],
    );
    await client.query("DELETE FROM inventory_negative_layer_settlements WHERE id = $1", [settlement.id]);
  }

  await client.query(
    `INSERT INTO stock_movements
       (location_id, inventory_item_id, type, quantity, unit_cost, cost_value_rial,
        source_type, source_id, created_by, inventory_event_id)
     VALUES ($1,$2,'production_output',-$3::numeric,$4,$5,'production',$6,$7,$8)`,
    [
      params.locationId,
      params.inventoryItemId,
      params.quantity,
      new Decimal(params.value.toString())
        .div(new Decimal(params.quantity))
        .toDecimalPlaces(9, Decimal.ROUND_HALF_UP)
        .toFixed(),
      params.value.toString(),
      params.reversalRunId,
      params.createdBy,
      params.reversalEventId,
    ],
  );

  const positiveValue = params.value - settledValue;
  if (positiveValue < 0n) throw new ProductionError("production_reversal_inconsistent");

  if (isLotBased(params.method)) {
    const { rows: lots } = await client.query<{
      id: string;
      original_quantity: string;
      remaining_qty: string;
      original_value_rial: string;
    }>(
      `SELECT id, original_quantity::text, remaining_qty::text, original_value_rial::text
         FROM inventory_lots
        WHERE inventory_item_id = $1 AND source_type = 'production' AND source_id = $2 AND inventory_event_id = $3
        ORDER BY received_at, id
        FOR UPDATE`,
      [params.inventoryItemId, params.originalRunId, params.originalEventId],
    );
    let removedValue = 0n;
    for (const lot of lots) {
      if (!new Decimal(lot.remaining_qty).eq(new Decimal(lot.original_quantity))) {
        throw new ProductionError("production_output_consumed");
      }
      removedValue += BigInt(lot.original_value_rial);
      await client.query("UPDATE inventory_lots SET remaining_qty = 0, remaining_value_rial = 0 WHERE id = $1", [
        lot.id,
      ]);
    }
    if (removedValue !== positiveValue) throw new ProductionError("production_reversal_inconsistent");
  } else {
    const { rows } = await client.query<{ carrying: string; physical: string }>(
      `SELECT COALESCE(carrying_value_rial,0)::text carrying,
              COALESCE((SELECT sum(quantity) FROM stock_movements WHERE inventory_item_id = $1),0)::text physical
         FROM inventory_items WHERE id = $1 FOR UPDATE`,
      [params.inventoryItemId],
    );
    const carrying = BigInt(rows[0].carrying);
    if (carrying < positiveValue) throw new ProductionError("production_output_consumed");
    const next = carrying - positiveValue;
    const physical = new Decimal(rows[0].physical);
    const average = physical.lte(0)
      ? "0"
      : new Decimal(next.toString()).div(physical).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
    await client.query("UPDATE inventory_items SET carrying_value_rial = $2, avg_cost = $3 WHERE id = $1", [
      params.inventoryItemId,
      next.toString(),
      average,
    ]);
  }

  return { upward: rialText(upward.toString()), downward: rialText(downward.toString()) };
}
