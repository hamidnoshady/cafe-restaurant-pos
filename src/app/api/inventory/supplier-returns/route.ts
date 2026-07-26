import { NextRequest,NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth";import { getPool } from "@/lib/db";
import { positiveQuantityText } from "@/lib/inventory-exact";
import { createSupplierReturn } from "@/lib/supplier-return-service";
import { resolveActiveLocation } from "@/lib/setup-state";
export const POST = withTenantScope(async (request:NextRequest) => {
 const {session,error}=await requireRole("owner","manager");if(error)return error;
 const location=await resolveActiveLocation(session);if(!location)return NextResponse.json({error:"no_location"},{status:409});
 let body:{purchaseId?:string;settlementMethod?:"accounts_payable"|"cash"|"bank"|"supplier_receivable";
 reason?:string;idempotencyKey?:string;lines?:Array<{purchaseItemId?:string;inventoryLotId?:string|null;quantity?:string}>};
 try{body=await request.json();}catch{return NextResponse.json({error:"bad_request"},{status:400});}
 const client=await getPool().connect();try{await client.query("BEGIN");
 const result=await createSupplierReturn(client,{businessId:session.businessId,locationId:location.id,
  purchaseId:body.purchaseId??"",settlementMethod:body.settlementMethod??"accounts_payable",
  reason:body.reason??"",idempotencyKey:body.idempotencyKey??"",createdBy:session.sub,
  lines:(body.lines??[]).map(l=>({purchaseItemId:l.purchaseItemId??"",inventoryLotId:l.inventoryLotId??null,
   quantity:positiveQuantityText(l.quantity??"")}))});
 await client.query("COMMIT");return NextResponse.json({ok:true,...result});
 }catch(err){await client.query("ROLLBACK");return NextResponse.json({error:(err as Error).message},{status:409});}
 finally{client.release();}
});
