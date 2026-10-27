import { ensureSchema, getPool, insertAuditRow } from "./db";
import { canAccessPatient } from "./patient-access";
import type { SessionPayload } from "./auth";
import { labPrescriptionVersion, validateLabPrescription, assertAutoLabSource, assertExplicitLabSource } from "./lab-prescription-input";
import { revalidateSessionInTransaction } from "./session";
import { PENDING_LAB_NAME } from "./lab";
export class LabPrescriptionError extends Error {
 constructor(message:string, readonly status:number){super(message);}
}
/** Clinical metadata only. Never creates/orders, guesses prices, posts money or sends messages. */
export async function completeLabPrescription(id:number, raw:unknown, expected:string, dispatch:boolean, session:SessionPayload) {
 const input=validateLabPrescription(raw, dispatch);
 if(!["admin","doctor"].includes(session.role)) throw new LabPrescriptionError("استكمال المواصفات السريرية للإرسالية للطبيب أو المدير.",403);
 await ensureSchema();
 const client=await getPool().connect();
 try{
  await client.query("BEGIN");
  // Take the ordinary DML table lock before row/user ownership locks. A composed
  // clinical authorization holds the conflicting table boundary; refuse, never invert its wait order.
  await client.query("LOCK TABLE lab_orders IN ROW EXCLUSIVE MODE NOWAIT");
  const active=await revalidateSessionInTransaction(session,client);
  if(!active || !["admin","doctor"].includes(active.role)) throw new LabPrescriptionError("انتهت صلاحية الجلسة أو تغيرت صلاحيات المستخدم.",403);
  const {rows}=await client.query(`SELECT patient_id, status, party_id, shade, stump_shade, tooth_numbers, due_date::text,
   impression_type, priority, payable_id, cost_minor, source, tooth_code, work_type, visit_id FROM lab_orders WHERE id=$1 FOR UPDATE`,[id]);
  const row=rows[0];
  if(!row) throw new LabPrescriptionError("الطلب غير موجود.",404);
  if(!await canAccessPatient(active,row.patient_id,undefined,client,"nowait")) throw new LabPrescriptionError("لا تملك صلاحية تعديل هذا الملف.",403);
  if(row.status!=="needed") throw new LabPrescriptionError("تغيّرت حالة الطلب؛ حدّث القائمة. تعديل الإرسالية متاح قبل الإرسال فقط.",409);
  const version=labPrescriptionVersion({status:row.status,partyId:row.party_id,shade:row.shade,stumpShade:row.stump_shade,toothNumbers:row.tooth_numbers,dueDate:row.due_date,impressionType:row.impression_type??"physical",priority:row.priority??"normal",workType:row.work_type,source:row.source,toothCode:row.tooth_code,visitId:row.visit_id});
  if(expected!==version) throw new LabPrescriptionError("تغيّرت بيانات الطلب؛ أغلق النموذج وحدّث القائمة قبل المحاولة.",409);
  try { assertAutoLabSource(input,row); } catch(error) { throw new LabPrescriptionError(error instanceof Error ? error.message : "نطاق الإرسالية لا يطابق المصدر.",409); }
  let storedToothNumbers = input.toothNumbers;
  const {labWorkIntentSupported} = await import("./lab-work-intent-db");
  if(await labWorkIntentSupported(client)) {
   // Immutable member/specification reads only: do not reverse source -> order write locks.
   const explicit = await client.query<{tooth_code:number;prescription:{toothNumbers?:string}}>(`SELECT m.tooth_code,i.prescription FROM lab_work_intents i
    JOIN lab_work_members m ON m.intent_id=i.id AND m.retired_revision IS NULL WHERE i.initial_order_id=$1`,[id]);
   if(explicit.rows.length) {
    const sourceCodes=explicit.rows.flatMap(member=>[member.tooth_code,...(member.prescription.toothNumbers??"").split(",").filter(Boolean).map(part=>Number(part.trim().slice(0,2)))]);
    try{storedToothNumbers=assertExplicitLabSource(input,sourceCodes,row.work_type);}catch(error){throw new LabPrescriptionError(error instanceof Error?error.message:"نطاق المصدر غير صالح.",409);}
   }
  }
  // Reassigning a financially linked order is not a clinical metadata operation.
  if(row.party_id!==input.partyId && (row.payable_id || row.cost_minor!==null)) throw new LabPrescriptionError("هذا الطلب مرتبط بتكلفة؛ راجع الربط المحاسبي قبل تغيير المختبر.",409);
  const {rows:labs}=input.partyId === null ? {rows:[{name:PENDING_LAB_NAME,phone:null}]} : await client.query(`SELECT name, phone FROM parties WHERE id=$1 AND kind='lab' AND is_active=TRUE FOR SHARE`,[input.partyId]);
  if(!labs[0]) throw new LabPrescriptionError("اختر مختبرًا مسجلًا ونشطًا.",409);
  await client.query(`UPDATE lab_orders SET party_id=$2, lab_name=$3, lab_phone=$4, shade=$5, stump_shade=$6,
   tooth_numbers=$7, due_date=$8::date, impression_type=$9, priority=$10,
   status=CASE WHEN $11 THEN 'sent' ELSE status END,
   sent_date=CASE WHEN $11 THEN CURRENT_DATE ELSE sent_date END WHERE id=$1`,
   [id,input.partyId,labs[0].name,labs[0].phone,input.shade||null,input.stumpShade||null,storedToothNumbers||null,input.dueDate,input.impressionType,input.priority,dispatch]);
  await client.query(`INSERT INTO lab_order_tracking (lab_order_id,action,from_status,to_status,notes,actor,actor_role)
   VALUES ($1,$6,'needed',$2,$3,$4,$5)`,[id,dispatch?"sent":"needed",dispatch?"استُكملت المواصفات وسُجّل الإرسال — لا إرسال آلي":"حُفظت مسوّدة المواصفات قبل الإرسال",active.username,active.role,dispatch?"prescription_completed":"prescription_draft_saved"]);
  await insertAuditRow(client,{action:"lab_order.prescription_updated",entity:"lab_order",entityId:id,
   details:{before:JSON.parse(version),after:{...input,toothNumbers:storedToothNumbers},sourceTooth:row.tooth_code,sourceWorkType:row.work_type,dispatch},
   actor:active.username,actorRole:active.role});
  await client.query("COMMIT");
  return {id,status:dispatch?"sent":"needed"};
 }catch(error){await client.query("ROLLBACK").catch(()=>{});if((error as {code?:string}).code==="55P03")throw new LabPrescriptionError("يوجد تحديث سريري جارٍ؛ أعد المحاولة بعد تحديث البيانات.",409);throw error;}finally{client.release();}
}
