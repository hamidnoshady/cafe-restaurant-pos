/**
 * Diagnoses legacy opening movements created before inventory event/cost-layer
 * integrity was introduced. Default is read-only. Apply only creates missing
 * FIFO lots or weighted-average cost after an operator-confirmed backup.
 * It never changes or deletes an existing stock movement or journal entry.
 */
import "dotenv/config";
import { Client } from "pg";

const apply = process.argv.includes("--apply");
const backupConfirmed = process.argv.includes("--backup-confirmed");
if (apply && !backupConfirmed) {
  console.error("Refusing apply: take and verify a database backup, then pass --backup-confirmed.");
  process.exit(2);
}
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows } = await client.query<{
    id:string; location_id:string; inventory_item_id:string; quantity:string; unit_cost:string;
    method:string; lot_qty:string;
  }>(`SELECT sm.id::text,sm.location_id,sm.inventory_item_id,sm.quantity::text,
      COALESCE(sm.unit_cost,0)::text,COALESCE(s.value->>'method','fifo') method,
      COALESCE((SELECT sum(remaining_qty) FROM inventory_lots il
                WHERE il.source_type='opening' AND il.inventory_item_id=sm.inventory_item_id),0)::text lot_qty
    FROM stock_movements sm JOIN locations l ON l.id=sm.location_id
    LEFT JOIN settings s ON s.business_id=l.business_id AND s.location_id IS NULL AND s.key='inventory.costing'
    WHERE sm.source_type='opening' AND sm.inventory_event_id IS NULL ORDER BY sm.id`);
  console.log(`${apply ? "APPLY" : "DRY RUN"}: ${rows.length} legacy opening movement(s).`);
  for (const row of rows) console.log(JSON.stringify(row));
  if (!apply || rows.length === 0) process.exit(0);
  await client.query("BEGIN");
  for (const row of rows) {
    if (row.method === "fifo" && Number(row.lot_qty) === 0) {
      await client.query(`INSERT INTO inventory_lots(location_id,inventory_item_id,remaining_qty,unit_cost,source_type,source_id,received_at)
        SELECT $1,$2,$3,$4,'opening',NULL,sm.occurred_at FROM stock_movements sm WHERE sm.id=$5`,
        [row.location_id,row.inventory_item_id,row.quantity,row.unit_cost,row.id]);
    } else if (row.method === "weighted_average") {
      await client.query("UPDATE inventory_items SET avg_cost=$2 WHERE id=$1 AND avg_cost=0",[row.inventory_item_id,row.unit_cost]);
    }
  }
  await client.query("COMMIT");
  console.log("Applied additive costing repairs. Re-run dry-run and reconcile Inventory Asset before proceeding.");
} catch (error) {
  await client.query("ROLLBACK").catch(()=>undefined);
  throw error;
} finally { await client.end(); }
