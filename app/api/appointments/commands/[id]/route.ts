import { NextResponse } from 'next/server';
import { readSessionPayload } from '@/lib/session';
import { isDirectAppointmentCommandId } from '@/lib/appointment-purpose-command';
import { recoverDirectPurposeAppointment } from '@/lib/book-direct-purpose';

export const dynamic='force-dynamic';
const json=(body:unknown,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});

/** A read-only lost-response lookup, scoped to the original actor and the
 * patient's current plan-view authority. It never creates an appointment. */
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
  // Signature-only admission: account/permission revalidation occurs on the
  // same read-only recovery transaction. No requireSession/ensureSchema DDL.
  const session=await readSessionPayload();
  if (!session) return json({message:'انتهت الجلسة. سجّل الدخول من جديد.'},401);
  if (!['admin','reception','doctor'].includes(session.role))
    return json({message:'غير مصرّح لك بعرض نتيجة هذا الأمر.'},403);
  const {id}=await params;
  if (!isDirectAppointmentCommandId(id))
    return json({message:'معرّف أمر الحجز غير صالح.'},400);
  try {
    const result=await recoverDirectPurposeAppointment(id,session);
    if (result.kind==='found')
      return json({id:result.appointmentId,status:result.status,replayed:true});
    if (result.kind==='not_found') return json({message:'لم تُثبت نتيجة لهذا الأمر بعد.'},404);
    if (result.kind==='denied_session')
      return json({message:'انتهت الجلسة أو تغيّرت صلاحيات الحساب.'},401);
    if (result.kind==='denied_scope')
      return json({message:'غير مصرّح لك بعرض نتيجة هذا الأمر.'},403);
    return json({message:'تعذّر تأكيد نتيجة هذا الأمر. تحقّق من هويته وصلاحياتك.'},409);
  } catch(error) {
    if ((error as {code?:string}).code==='55P03')
      return json({message:'يجري تحديث ارتباط المريض؛ أعد الاستعلام بالمفتاح نفسه.'},409);
    if (['42P01','42703'].includes((error as {code?:string}).code??''))
      return json({message:'سجل أوامر الحجز غير جاهز؛ احتفظ بمعرّف الأمر.'},503);
    return json({message:'تعذّر التحقق من النتيجة؛ احتفظ بمعرّف الأمر وأعد الاستعلام.'},500);
  }
}
