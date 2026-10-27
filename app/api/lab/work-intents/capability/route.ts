import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSession, revalidateSessionInTransaction } from "@/lib/session";
import { labWorkIntentSupported } from "@/lib/lab-work-intent-db";
export const dynamic = "force-dynamic";
/** Read only feature detection. A missing proposal never triggers schema installation. */
export async function GET() {
 const session=await requireSession();
 if(!session)return NextResponse.json({supported:false},{status:401});
 const client=await getPool().connect();
 try {
  await client.query("BEGIN");
  const active=await revalidateSessionInTransaction(session,client);
  const supported=!!active&&["admin","doctor"].includes(active.role)&&await labWorkIntentSupported(client);
  await client.query("ROLLBACK");
  return NextResponse.json({supported},{headers:{"Cache-Control":"no-store"}});
 }catch {await client.query("ROLLBACK").catch(()=>{});return NextResponse.json({supported:false},{status:503});}
 finally{client.release();}
}
