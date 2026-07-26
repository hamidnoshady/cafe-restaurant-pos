import { NextResponse } from "next/server";
import { requireRole, withTenantScope } from "@/lib/auth"; import { getPool } from "@/lib/db";
import { shipInventoryTransfer } from "@/lib/transfer-service";
export const POST = withTenantScope(async (_request:Request,context:{params:Promise<{id:string}>}) => {
 const {session,error}=await requireRole("owner","manager");if(error)return error;const {id}=await context.params;
 const client=await getPool().connect();try{await client.query("BEGIN");
 const result=await shipInventoryTransfer(client,{businessId:session.businessId,transferId:id,actorId:session.sub});
 await client.query("COMMIT");return NextResponse.json({ok:true,...result});
 }catch(err){await client.query("ROLLBACK");return NextResponse.json({error:(err as Error).message},{status:409});}
 finally{client.release();}
});
