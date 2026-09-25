import { NextRequest,NextResponse } from "next/server";
import { withTenantScope, requirePermission } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { getPool } from "@/lib/db";
import { positiveQuantityText } from "@/lib/inventory-exact";
import { createInventoryTransfer } from "@/lib/transfer-service";

export const GET = withTenantScope(async () => {
 const {session,error}=await requirePermission(PERMISSIONS.inventoryView); if(error)return error;
 const pool = getPool();
 const { rows: transfers } = await pool.query(
  `SELECT t.id, t.status::text AS status, t.note, t.created_at,
          t.shipped_at, t.received_at, t.cancelled_at,
          sl.name AS source_location_name, dl.name AS destination_location_name,
          (SELECT COUNT(*)::int FROM inventory_transfer_lines tl WHERE tl.transfer_id=t.id) AS line_count
   FROM inventory_transfers t
   JOIN locations sl ON sl.id = t.source_location_id
   JOIN locations dl ON dl.id = t.destination_location_id
   WHERE t.business_id = $1
   ORDER BY t.created_at DESC LIMIT 100`,
  [session.businessId]);
 return NextResponse.json({ transfers });
});

export const POST = withTenantScope(async (request:NextRequest) => {
 const {session,error}=await requirePermission(PERMISSIONS.inventoryAdjust); if(error)return error;
 let body:{sourceLocationId?:string;destinationLocationId?:string;note?:string;idempotencyKey?:string;
 lines?:Array<{sourceInventoryItemId?:string;destinationInventoryItemId?:string;quantity?:string}>};
 try{body=await request.json();}catch{return NextResponse.json({error:"bad_request"},{status:400});}
 const client=await getPool().connect();
 try{await client.query("BEGIN");const result=await createInventoryTransfer(client,{
  businessId:session.businessId,createdBy:session.sub,sourceLocationId:body.sourceLocationId??"",
  destinationLocationId:body.destinationLocationId??"",note:body.note,idempotencyKey:body.idempotencyKey??"",
  sync:{actorRole:session.role},
  lines:(body.lines??[]).map(l=>({sourceInventoryItemId:l.sourceInventoryItemId??"",
   destinationInventoryItemId:l.destinationInventoryItemId??"",quantity:positiveQuantityText(l.quantity??"")}))});
  await client.query("COMMIT");return NextResponse.json({ok:true,...result});
 }catch(err){await client.query("ROLLBACK");return NextResponse.json({error:(err as Error).message},{status:409});}
 finally{client.release();}
});
