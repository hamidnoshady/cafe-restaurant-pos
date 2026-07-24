import { NextRequest,NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { positiveQuantityText } from "@/lib/inventory-exact";
import { createInventoryTransfer } from "@/lib/transfer-service";
export async function POST(request:NextRequest){
 const {session,error}=await requireRole("owner","manager"); if(error)return error;
 let body:{sourceLocationId?:string;destinationLocationId?:string;note?:string;idempotencyKey?:string;
 lines?:Array<{sourceInventoryItemId?:string;destinationInventoryItemId?:string;quantity?:string}>};
 try{body=await request.json();}catch{return NextResponse.json({error:"bad_request"},{status:400});}
 const client=await getPool().connect();
 try{await client.query("BEGIN");const result=await createInventoryTransfer(client,{
  businessId:session.businessId,createdBy:session.sub,sourceLocationId:body.sourceLocationId??"",
  destinationLocationId:body.destinationLocationId??"",note:body.note,idempotencyKey:body.idempotencyKey??"",
  lines:(body.lines??[]).map(l=>({sourceInventoryItemId:l.sourceInventoryItemId??"",
   destinationInventoryItemId:l.destinationInventoryItemId??"",quantity:positiveQuantityText(l.quantity??"")}))});
  await client.query("COMMIT");return NextResponse.json({ok:true,...result});
 }catch(err){await client.query("ROLLBACK");return NextResponse.json({error:(err as Error).message},{status:409});}
 finally{client.release();}
}
