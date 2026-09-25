import Decimal from "decimal.js";
import type { PoolClient } from "pg";
import {
  positiveQuantityText, proportionalDepletionValue, quantityText, rialBigInt, rialText,
  subtractQuantity, type QuantityText, type RialText,
} from "./inventory-exact";
import { postExactOperationalInventoryEntry } from "./ledger-service";
import { WELL_KNOWN_CODES } from "./coa-template";
import { getCostingMethod, getInventorySystem } from "./inventory-service";
import { appendSyncOutboxEvent } from "./sync-outbox";
import type { Role } from "./auth-edge";

export async function createSupplierReturn(client:PoolClient,params:{
 businessId:string;locationId:string;purchaseId:string;settlementMethod:"accounts_payable"|"cash"|"bank"|"supplier_receivable";
 reason:string;idempotencyKey:string;createdBy:string;sync?:{actorRole:Role;clientEventId?:string};
 lines:Array<{purchaseItemId:string;inventoryLotId?:string|null;quantity:QuantityText}>;
}):Promise<{id:string;value:RialText;duplicate:boolean}>{
 if(!params.reason.trim()||!params.idempotencyKey||!params.lines.length)throw new Error("invalid_supplier_return");
 const {rows:prior}=await client.query<{id:string;total_value_rial:string}>(
  "SELECT id,total_value_rial::text FROM supplier_returns WHERE business_id=$1 AND idempotency_key=$2",
  [params.businessId,params.idempotencyKey]);
 if(prior[0])return{id:prior[0].id,value:rialText(prior[0].total_value_rial),duplicate:true};
 const {rows:purchases}=await client.query<{id:string}>(
  "SELECT id FROM purchases WHERE id=$1 AND location_id=$2 AND status='received' FOR UPDATE",
  [params.purchaseId,params.locationId]);
 if(!purchases[0])throw new Error("received_purchase_not_found");
 const {rows:headers}=await client.query<{id:string}>(
  `INSERT INTO supplier_returns
   (business_id,location_id,purchase_id,settlement_method,total_value_rial,reason,created_by,idempotency_key)
   VALUES($1,$2,$3,$4,0,$5,$6,$7) RETURNING id`,
  [params.businessId,params.locationId,params.purchaseId,params.settlementMethod,params.reason.trim(),params.createdBy,params.idempotencyKey]);
 const {rows:events}=await client.query<{id:string}>(
  `INSERT INTO inventory_events
   (business_id,location_id,event_type,source_type,source_id,created_by,costing_version,idempotency_key)
   VALUES($1,$2,'supplier_return','supplier_return',$3,$4,2,$5) RETURNING id`,
 [params.businessId,params.locationId,headers[0].id,params.createdBy,`supplier-return:${params.idempotencyKey}`]);
 // ادواری: a supplier return of a journal-only purchase is a manual credit
 // note against 5105 — this perpetual path (lots/carrying value) can't model it.
 if((await getInventorySystem(params.businessId,client))==="periodic")throw new Error("periodic_system_unsupported");
 const method=await getCostingMethod(params.businessId,client);
 let total=0n;
 for(const line of params.lines){
  const quantity=positiveQuantityText(line.quantity);
  if(method==="weighted_average"){
   const {rows:items}=await client.query<{
    inventory_item_id:string;quantity:string;extended_cost:string;carrying_value_rial:string|null;stock:string;
   }>(`SELECT pi.inventory_item_id,pi.quantity::text,pi.extended_cost::text,
       item.carrying_value_rial::text,
       (SELECT COALESCE(sum(quantity),0)::text FROM stock_movements WHERE inventory_item_id=item.id) stock
       FROM purchase_items pi JOIN purchases p ON p.id=pi.purchase_id
       JOIN inventory_items item ON item.id=pi.inventory_item_id
       WHERE pi.id=$1 AND p.id=$2 AND p.location_id=$3 FOR UPDATE OF item`,
    [line.purchaseItemId,params.purchaseId,params.locationId]);
   const item=items[0];if(!item)throw new Error("supplier_return_purchase_item_not_found");
   if(item.carrying_value_rial===null)throw new Error("inventory_exact_cutover_required");
   const {rows:priorRows}=await client.query<{quantity:string;value:string}>(
    `SELECT COALESCE(sum(l.quantity),0)::text quantity,COALESCE(sum(l.value_rial),0)::text value
     FROM supplier_return_lines l JOIN supplier_returns r ON r.id=l.supplier_return_id
     WHERE r.purchase_id=$1 AND l.purchase_item_id=$2`,[params.purchaseId,line.purchaseItemId]);
   const receiptRemaining=subtractQuantity(quantityText(item.quantity),quantityText(priorRows[0].quantity));
   subtractQuantity(receiptRemaining,quantity);
   subtractQuantity(quantityText(item.stock),quantity);
   const receiptRemainingValue=BigInt(item.extended_cost)-BigInt(priorRows[0].value);
   const value=proportionalDepletionValue(receiptRemaining,rialText(receiptRemainingValue.toString()),quantity);
   if(BigInt(value)>BigInt(item.carrying_value_rial))throw new Error("supplier_return_value_exceeds_carrying_value");
   const nextStock=subtractQuantity(quantityText(item.stock),quantity);
   const nextValue=BigInt(item.carrying_value_rial)-BigInt(value);
   const nextStockDecimal = new Decimal(nextStock);
   const positiveNextStock = Decimal.max(nextStockDecimal, new Decimal("0"));
   const avg = positiveNextStock.lte(0)
     ? "0"
     : new Decimal(nextValue.toString()).div(positiveNextStock).toDecimalPlaces(9, Decimal.ROUND_HALF_UP).toFixed();
   await client.query(
    `UPDATE inventory_items SET carrying_value_rial=$2,
      avg_cost=$3 WHERE id=$1`,
    [item.inventory_item_id, positiveNextStock.lte(0) ? "0" : nextValue.toString(), avg]);
   const {rows:movements}=await client.query<{id:string}>(
    `INSERT INTO stock_movements
     (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
     VALUES($1,$2,'adjustment',-$3::numeric,$4::numeric/$3::numeric,$4,'supplier_return',$5,$6,$7) RETURNING id`,
    [params.locationId,item.inventory_item_id,quantity,value,headers[0].id,params.createdBy,events[0].id]);
   await client.query(
    `INSERT INTO supplier_return_lines
     (supplier_return_id,purchase_item_id,inventory_lot_id,quantity,value_rial,stock_movement_id)
     VALUES($1,$2,NULL,$3,$4,$5)`,
    [headers[0].id,line.purchaseItemId,quantity,value,movements[0].id]);
   total+=rialBigInt(value);
   continue;
  }
  if(!line.inventoryLotId)throw new Error("supplier_return_lot_required");
  const {rows:lots}=await client.query<{
   inventory_item_id:string;remaining_qty:string;remaining_value_rial:string|null;
  }>(`SELECT lot.inventory_item_id,lot.remaining_qty::text,lot.remaining_value_rial::text
      FROM inventory_lots lot JOIN purchase_items pi ON pi.id=$2 AND pi.inventory_item_id=lot.inventory_item_id
      WHERE lot.id=$1 AND lot.location_id=$3 AND lot.source_type='purchase' AND lot.source_id=$4 FOR UPDATE`,
    [line.inventoryLotId,line.purchaseItemId,params.locationId,params.purchaseId]);
  const lot=lots[0];if(!lot)throw new Error("supplier_return_lot_not_found");
  if(lot.remaining_value_rial===null)throw new Error("inventory_exact_cutover_required");
  const remaining=quantityText(lot.remaining_qty);
  const value=proportionalDepletionValue(remaining,rialText(lot.remaining_value_rial),quantity);
  const nextQty=subtractQuantity(remaining,quantity);
  await client.query("UPDATE inventory_lots SET remaining_qty=$2,remaining_value_rial=$3 WHERE id=$1",
   [line.inventoryLotId,nextQty,(BigInt(lot.remaining_value_rial)-BigInt(value)).toString()]);
  const {rows:movements}=await client.query<{id:string}>(
   `INSERT INTO stock_movements
    (location_id,inventory_item_id,type,quantity,unit_cost,cost_value_rial,source_type,source_id,created_by,inventory_event_id)
    VALUES($1,$2,'adjustment',-$3::numeric,$4::numeric/$3::numeric,$4,'supplier_return',$5,$6,$7) RETURNING id`,
   [params.locationId,lot.inventory_item_id,quantity,value,headers[0].id,params.createdBy,events[0].id]);
  await client.query(
   `INSERT INTO supplier_return_lines
    (supplier_return_id,purchase_item_id,inventory_lot_id,quantity,value_rial,stock_movement_id)
    VALUES($1,$2,$3,$4,$5,$6)`,
   [headers[0].id,line.purchaseItemId,line.inventoryLotId,quantity,value,movements[0].id]);
  total+=rialBigInt(value);
 }
 await client.query("UPDATE supplier_returns SET total_value_rial=$2,inventory_event_id=$3 WHERE id=$1",
  [headers[0].id,total.toString(),events[0].id]);
 const debitCode=params.settlementMethod==="cash"?WELL_KNOWN_CODES.cash:
  params.settlementMethod==="bank"?WELL_KNOWN_CODES.bankClearing:
  params.settlementMethod==="supplier_receivable"?WELL_KNOWN_CODES.supplierReceivable:WELL_KNOWN_CODES.accountsPayable;
 await postExactOperationalInventoryEntry(client,{businessId:params.businessId,locationId:params.locationId,
  sourceType:"supplier_return",sourceId:headers[0].id,postingKind:"supplier_return",memo:"Supplier return",
  createdBy:params.createdBy,inventoryEventId:events[0].id,debitCode,creditCode:WELL_KNOWN_CODES.inventory,
  amount:rialText(total.toString())});
 await client.query("UPDATE inventory_events SET posting_status='posted' WHERE id=$1",[events[0].id]);
 if(params.sync)await appendSyncOutboxEvent(client,{
  locationId:params.locationId,clientEventId:params.sync.clientEventId??params.idempotencyKey,
  eventType:"inventory.supplier_return.created",payload:{purchaseId:params.purchaseId,
   settlementMethod:params.settlementMethod,reason:params.reason,lines:params.lines},
  actorUserId:params.createdBy,actorRole:params.sync.actorRole,
 });
 return{id:headers[0].id,value:rialText(total.toString()),duplicate:false};
}
