/** A classified direct booking is a durable command, not an optional label on
 * the legacy booking path. The receipt is checked before any mutable service or
 * capacity reads, and no writer side effect runs on replay. */
import type { SessionPayload } from './auth';
import type { Appointment } from './schedule';
import type { CapacityVerdict } from './capacity';
import type { BookingActor, BookingConflict } from './book-appointment';
import { actorCanOverride, judgeBookingInDay } from './book-appointment';
import { canAccessPatient } from './patient-access';
import { revalidateSessionInTransaction } from './session';
import { PURCHASE_RESET_FENCE } from './clinic-reset';
import { APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE, lockBookableAppointmentDoctor } from './appointment-doctor';
import { MIN_DURATION, MAX_DURATION, type AppointmentService } from './appointment-services';
import { loadCapacityContext, resolveService, type CapacityContext } from './capacity-context';
import {
  fingerprintDirectAppointmentIntent, isDirectAppointmentCommandId,
  normalizeDirectAppointmentIntent, type DirectAppointmentIntent,
  type NormalizedDirectAppointmentIntent,
} from './appointment-purpose-command';
import { findDirectAppointmentCommandReceipt, insertAppointmentPurposeProvenance } from './appointment-purpose';
import {
  findUserByUsername, getAppointmentOnClient, getPool, insertAppointmentOnClient, insertAuditRow,
  lockAppointmentServiceForBooking, writeAppointmentInDay, type DbClient,
} from './db';

type DirectDenied = {ok:false; status:400|401|403|409; message:string; conflict?:BookingConflict};
export type DirectPurposeBookingResult =
  | {ok:true; replayed:true; appointmentId:number; status:Appointment['status']}
  | {ok:true; replayed:false; appointment:Appointment; verdict:CapacityVerdict;
      overridden:boolean; warning:string|null}
  | DirectDenied;

const DENIED_COMMAND = 'تعذّر تأكيد نتيجة هذا الأمر. تحقّق من هويته وصلاحياتك.';
const DENIED_SESSION = 'انتهت الجلسة أو تغيّرت صلاحيات الحساب.';
const DENIED_PLAN = 'غير مصرّح لك بتوثيق غرض موعد لهذا المريض.';

/** Same order for POST and recovery: UUID → reset fence → fresh account/scope.
 * The session is server-admitted, never taken from request JSON. */
export async function lockDirectPurposeCommand(client:DbClient, commandId:string):Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('appointment-purpose-direct'), hashtext($1::text))",[commandId]);
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))',[PURCHASE_RESET_FENCE]);
}

export async function freshDirectPurposeActor(client:DbClient, session:SessionPayload) {
  const current=await revalidateSessionInTransaction(session,client);
  if (!current) return null;
  const user=await findUserByUsername(current.username,client);
  return user?.id===current.userId ? {current,user} : null;
}

/** Read-only recovery of a completed command, never permission to mint another
 * UUID. The same serialization point waits for an in-flight POST's commit. */
export async function recoverDirectPurposeAppointment(commandId:string,session:SessionPayload):Promise<
  {kind:'found';appointmentId:number;status:Appointment['status']}|
  {kind:'not_found'|'denied_session'|'denied_actor'|'denied_scope'}> {
  if (!isDirectAppointmentCommandId(commandId)) return {kind:'not_found'};
  // Read-only recovery never runs a schema initializer or migration. Missing
  // registered 0095 fails closed, rather than adopting or changing a catalog.
  const client=await getPool().connect();
  try {
    await client.query('BEGIN');
    await lockDirectPurposeCommand(client,commandId);
    const fresh=await freshDirectPurposeActor(client,session);
    if (!fresh) {await client.query('ROLLBACK');return {kind:'denied_session'};}
    const receipt=await findDirectAppointmentCommandReceipt(client,commandId);
    if (!receipt) {await client.query('COMMIT');return {kind:'not_found'};}
    if (receipt.actorUserId!==fresh.user.id || receipt.recordedBy!==fresh.current.username) {
      await client.query('ROLLBACK');return {kind:'denied_actor'};
    }
    if (!await canAccessPatient(fresh.current,receipt.patientId,'canViewPlans',client,'nowait')) {
      await client.query('ROLLBACK');return {kind:'denied_scope'};
    }
    if (fresh.current.role==='doctor' &&
      (!fresh.user.partyId || !await lockBookableAppointmentDoctor(client,fresh.user.partyId,true))) {
      await client.query('ROLLBACK');return {kind:'denied_scope'};
    }
    const appointment=await getAppointmentOnClient(client,receipt.appointmentId,true);
    if (!appointment || appointment.patientId!==receipt.patientId)
      throw new Error('APPOINTMENT_PURPOSE_RECEIPT_BROKEN');
    if (!await revalidateSessionInTransaction(session,client)) {
      await client.query('ROLLBACK');return {kind:'denied_session'};
    }
    await client.query('COMMIT');
    return {kind:'found',appointmentId:appointment.id,status:appointment.status};
  } catch(error) {
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  } finally {client.release();}
}

export async function bookDirectPurposeAppointment(input:DirectAppointmentIntent & {commandId:string},
  actor:BookingActor & {session:SessionPayload}):Promise<DirectPurposeBookingResult> {
  if (!isDirectAppointmentCommandId(input.commandId))
    return {ok:false,status:400,message:'معرّف أمر الحجز غير صالح.'};
  let intent:NormalizedDirectAppointmentIntent;
  let commandHash:string;
  try {
    intent=normalizeDirectAppointmentIntent(input);
    commandHash=fingerprintDirectAppointmentIntent(intent);
  } catch {
    return {ok:false,status:400,message:'بيانات أمر الحجز غير صالحة.'};
  }
  // The route must pass the signed admitted session. This guard also protects
  // any future server caller that attempts direct booking without one.
  if (!actor.session || actor.session.username!==actor.username)
    return {ok:false,status:401,message:DENIED_SESSION};

  let denied:DirectDenied|null=null;
  let context:CapacityContext|null=null;
  let service:AppointmentService|null=null;
  let durationMinutes=30;
  let doctorId:number|null=null;
  let canOverride=false;
  let verdict:CapacityVerdict|null=null;
  let overridden=false;
  let fresh:NonNullable<Awaited<ReturnType<typeof freshDirectPurposeActor>>>|null=null;
  const reject=(status:DirectDenied['status'],message:string) => {
    denied={ok:false,status,message};
    return {ok:false as const, conflict:null};
  };

  const result=await writeAppointmentInDay<Appointment>({
    date:intent.date,
    prelude:async client=>{
      await lockDirectPurposeCommand(client,input.commandId);
      fresh=await freshDirectPurposeActor(client,actor.session);
      if (!fresh) return {kind:'rejected' as const,conflict:reject(401,DENIED_SESSION)};
      const receipt=await findDirectAppointmentCommandReceipt(client,input.commandId);
      if (!receipt) return {kind:'continue' as const};
      if (receipt.actorUserId!==fresh.user.id || receipt.recordedBy!==fresh.current.username
        || receipt.commandHash!==commandHash)
        return {kind:'rejected' as const,conflict:reject(409,DENIED_COMMAND)};
      if (!await canAccessPatient(fresh.current,receipt.patientId,'canViewPlans',client,'nowait'))
        return {kind:'rejected' as const,conflict:reject(403,DENIED_PLAN)};
      if (fresh.current.role==='doctor' &&
        (!fresh.user.partyId || !await lockBookableAppointmentDoctor(client,fresh.user.partyId,true)))
        return {kind:'rejected' as const,conflict:reject(403,DENIED_PLAN)};
      const appointment=await getAppointmentOnClient(client,receipt.appointmentId,true);
      if (!appointment || appointment.patientId!==receipt.patientId)
        throw new Error('APPOINTMENT_PURPOSE_RECEIPT_BROKEN');
      if (!await revalidateSessionInTransaction(actor.session,client))
        return {kind:'rejected' as const,conflict:reject(401,DENIED_SESSION)};
      return {kind:'replayed' as const,value:appointment};
    },
    judge:async (sameDay,client)=>{
      fresh=await freshDirectPurposeActor(client,actor.session);
      if (!fresh) return reject(401,DENIED_SESSION);
      if (!await canAccessPatient(fresh.current,intent.patientId,'canViewPlans',client,'nowait'))
        return reject(403,DENIED_PLAN);
      context=await loadCapacityContext(client);
      service=await resolveService({serviceId:intent.serviceId,appointmentType:intent.appointmentType},client);
      if (intent.serviceId!==null && service?.id!==intent.serviceId)
        return reject(400,'تغيّرت خدمة الموعد؛ حدّث قائمة الخدمات وأعد الحجز.');
      if (service) {
        service=await lockAppointmentServiceForBooking(client,service.id);
        if (!service?.isActive) return reject(400,'تغيّرت خدمة الموعد؛ حدّث قائمة الخدمات وأعد الحجز.');
      }
      durationMinutes=intent.durationMinutes??service?.defaultDurationMinutes??30;
      if (durationMinutes<MIN_DURATION || durationMinutes>MAX_DURATION)
        return reject(400,`المدّة يجب أن تكون بين ${MIN_DURATION} و${MAX_DURATION} دقيقة.`);
      if (intent.chairNo!==null && intent.chairNo>context.chairs)
        return reject(400,`رقم الكرسي يجب أن يكون بين ١ و${context.chairs}.`);
      doctorId=fresh.current.role==='doctor' ? fresh.user.partyId : intent.doctorId;
      if (fresh.current.role==='doctor' && doctorId===null) return reject(403,DENIED_PLAN);
      if (!await lockBookableAppointmentDoctor(client,doctorId,true))
        return reject(400,APPOINTMENT_DOCTOR_UNAVAILABLE_MESSAGE);
      canOverride=actorCanOverride({username:fresh.current.username,role:fresh.current.role,
        channel:actor.channel,canOverrideCapacity:fresh.user.permissions?.canOverrideCapacity===true});
      const judged=await judgeBookingInDay({sameDay,client,date:intent.date,time:intent.time,
        durationMinutes,service,context,providerId:doctorId,chairNo:intent.chairNo,
        isNewPatient:intent.isNewPatient,patientId:intent.patientId,canOverride,
        overrideReason:intent.overrideReason??''});
      verdict=judged.verdict;
      if (!judged.ok) return {ok:false as const,conflict:judged.conflict};
      overridden=judged.overridden;
      return {ok:true as const};
    },
    commit:async client=>{
      if (!fresh || !context || !verdict) throw new Error('APPOINTMENT_PURPOSE_JUDGE_MISSING');
      const appointment=await insertAppointmentOnClient(client,{
        patientId:intent.patientId,date:intent.date,time:intent.time,durationMinutes,
        appointmentType:intent.appointmentType??service?.legacyType??null,
        note:intent.note,doctorId,serviceId:service?.id??null,
        bufferBeforeMinutes:service?.bufferBeforeMinutes??0,
        bufferAfterMinutes:service?.bufferAfterMinutes??0,
        chairNo:intent.chairNo,occupiesChair:service?.requiresChair??true,
        isNewPatient:intent.isNewPatient,waitingListId:null,
      });
      if (!appointment) throw new Error('APPOINTMENT_PURPOSE_APPOINTMENT_MISSING');
      await insertAppointmentPurposeProvenance(client,{appointmentId:appointment.id,
        purpose:intent.appointmentPurpose,sourcePlanId:null,sourcePlannedVisitId:null,
        recordedBy:fresh.current.username,commandId:input.commandId,
        commandHash,actorUserId:fresh.user.id});
      await insertAuditRow(client,{action:'appointment.purpose_recorded',entity:'appointment',
        entityId:appointment.id,actor:fresh.current.username,actorRole:fresh.current.role,
        details:{purpose:intent.appointmentPurpose,patientId:intent.patientId,
          sourcePlanId:null,sourcePlannedVisitId:null,commandId:input.commandId}});
      if (overridden) await insertAuditRow(client,{action:'appointment.capacity_override',entity:'appointment',
        entityId:appointment.id,actor:fresh.current.username,actorRole:fresh.current.role,
        details:{date:intent.date,time:intent.time,reason:intent.overrideReason,
          capacityState:verdict.state,channel:actor.channel}});
      if (!await revalidateSessionInTransaction(actor.session,client))
        throw new Error('APPOINTMENT_PURPOSE_SESSION_EXPIRED');
      return appointment;
    },
  });
  if (!result.ok) return denied??{ok:false,status:409,message:'تعذّر حجز الموعد بسبب التعارض.',
    conflict:result.conflict as BookingConflict};
  if (result.replayed) return {ok:true,replayed:true,appointmentId:result.value.id,status:result.value.status};
  if (!verdict) throw new Error('APPOINTMENT_PURPOSE_JUDGE_MISSING');
  return {ok:true,replayed:false,appointment:result.value,verdict,overridden,
    warning:verdict.outsideHours?'هذا الوقت خارج ورديات المركز — تأكّد قبل أن تَعِد المريض.':
      verdict.state==='NEAR_CAPACITY'?verdict.message:null};
}
