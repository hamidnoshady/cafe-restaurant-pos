import { NextRequest,NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { cancelInventoryTransfer } from "@/lib/transfer-service";
export async function POST(_request:NextRequest,context:{params:Promise<{id:string}>}){
 const {session,error}=await requireRole("owner","manager");if(error)return error;
 const client=await getPool().connect();try{await client.query("BEGIN");const {id}=await context.params;
 const result=await cancelInventoryTransfer(client,{businessId:session.businessId,transferId:id,actorId:session.sub});
 await client.query("COMMIT");return NextResponse.json({ok:true,...result});
 }catch(err){await client.query("ROLLBACK");return NextResponse.json({error:(err as Error).message},{status:409});}
 finally{client.release();}
}
