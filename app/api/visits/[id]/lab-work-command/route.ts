import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { labWorkIntentSupported, readLabWorkCommandInTransaction, LabWorkIntentError } from "@/lib/lab-work-intent-db";
export const dynamic = "force-dynamic";
/** Reconcile an exact actor-bound operation without persisting or recovering its clinical body. */
export async function GET(request:Request,context:{params:Promise<{id:string}>}) {
 const session=await requireSession();
 if(!session)return NextResponse.json({message:"انتهت الجلسة."},{status:401});
 if(!["admin","doctor"].includes(session.role))return NextResponse.json({message:"هذه العملية للطبيب أو المدير."},{status:403});
 const visitId=Number((await context.params).id),url=new URL(request.url);
 const requestKey=url.searchParams.get("key")??"",requestHash=url.searchParams.get("hash")??"";
 if(!Number.isSafeInteger(visitId)||visitId<=0||!/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey)||!/^[a-f0-9]{64}$/.test(requestHash))return NextResponse.json({message:"مرجع العملية غير صالح."},{status:400});
 const client=await getPool().connect();
 try {
  await client.query("BEGIN");
  if(!await labWorkIntentSupported(client))throw new LabWorkIntentError("schema_unavailable",503);
  const visit=(await client.query<{patient_id:number|null}>("SELECT patient_id FROM visits WHERE id=$1",[visitId])).rows[0];
  if(!visit?.patient_id)throw new LabWorkIntentError("visit_unavailable",404);
  await client.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE NOWAIT",[visit.patient_id]);
  const locked=(await client.query<{patient_id:number|null}>("SELECT patient_id FROM visits WHERE id=$1 FOR SHARE NOWAIT",[visitId])).rows[0];
  if(locked?.patient_id!==visit.patient_id)throw new LabWorkIntentError("source_changed",409);
  const result=await readLabWorkCommandInTransaction(client,{patientId:visit.patient_id,sourceKind:"visit",sourceId:visitId,session,requestKey,requestHash});
  await client.query("ROLLBACK");
  return NextResponse.json(result?{found:true,receipt:{requestKey,requestHash,visitId,patientId:visit.patient_id,actor:session.username},result}:{found:false},{headers:{"Cache-Control":"no-store"}});
 }catch(error){
  await client.query("ROLLBACK").catch(()=>{});
  const status=error instanceof LabWorkIntentError?error.status:(error as {code?:string}).code==="55P03"?409:500;
  return NextResponse.json({message:"تعذّر إثبات نتيجة العملية؛ لا تنشئ طلبًا بديلًا."},{status});
 }finally{client.release();}
}
