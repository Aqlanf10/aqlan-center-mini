import { createHash } from 'node:crypto';
import { insertAuditRow, type DbClient, type DbPool } from './db';
import { withTransaction } from './transactions';
import { immutableJson, HrTemporalError } from './hr-temporal';
import { appendHrTimelineInTransaction } from './hr-temporal-store';
import { requireHrTemporalAuthority, type HrTemporalAuthority } from './hr-temporal-authority';
import { canonicalHrIntent, historyFail, parseHrHistoryCommand, HrHistoryError, HrHistoryWriteRefusal, type HrHistoryCommand, type HrHistoryReceipt } from './hr-temporal-request';

/** No environment switch enables projection: final-union ownership remains explicit. */
export const HR_TEMPORAL_ACTIVATION = 'documented_only' as const;
export async function requireHrHistorySchema(client: Pick<DbClient, 'query'>): Promise<void> {
  const { rows: [row] } = await client.query<{ available: boolean }>(`SELECT to_regclass('public.hr_effective_streams') IS NOT NULL
    AND to_regclass('public.hr_effective_revisions') IS NOT NULL AND to_regclass('public.hr_temporal_write_receipts') IS NOT NULL AS available`);
  if (!row?.available) historyFail('integration_pending', 'توثيق التاريخ غير مفعّل في هذه النسخة؛ يلزم اعتماد إدماج المخطط أولًا.', 503);
}
export async function recordHrHistory(pool: DbPool, authority: HrTemporalAuthority, input: HrHistoryCommand): Promise<HrHistoryReceipt> {
  requireHrTemporalAuthority(authority);
  // Re-validate even trusted server callers; the subject and operation cannot be smuggled in a body.
  const { staffId, operation, ...body } = input;
  const kind = operation === 'employment.record' ? 'employment' : operation === 'schedule.record' ? 'schedule' : historyFail('invalid_operation', 'عملية تاريخ غير صالحة.', 400);
  const command = parseHrHistoryCommand(body, kind, staffId), canonical = canonicalHrIntent(command);
  const digest = createHash('sha256').update(canonical).digest('hex');
  let callbackCompleted = false;
  try { return await withTransaction(pool, async client => {
    const actor = await authority.verify(client);
    if (command.expectedUsername !== actor.username) historyFail('owner_changed', 'تغيّر صاحب الجلسة؛ لا يُعاد طلب محفوظ باسم مستخدم آخر.', 403);
    await requireHrHistorySchema(client);
    // Existing authority-before-resource order: user SHARE → staff → stream → request.
    const staff = await client.query('SELECT id FROM hr_staff WHERE id=$1 FOR UPDATE', [staffId]);
    if (!staff.rows.length) historyFail('staff_not_found', 'ملف الموظف غير موجود.', 404);
    await authority.verify(client);
    await client.query('INSERT INTO hr_effective_streams(kind,subject_key,staff_id) VALUES($1,$2,$3) ON CONFLICT(kind,subject_key) DO NOTHING', [kind, String(staffId), staffId]);
    const { rows: [stream] } = await client.query('SELECT id FROM hr_effective_streams WHERE kind=$1 AND subject_key=$2 FOR UPDATE', [kind, String(staffId)]);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`hr-history:${actor.userId}:${operation}:${command.requestId}`]);
    await authority.verify(client);
    const prior = await client.query('SELECT intent_digest,intent_canonical,response FROM hr_temporal_write_receipts WHERE actor_user_id=$1 AND operation=$2 AND request_id=$3', [actor.userId, operation, command.requestId]);
    if (prior.rows.length) {
      if (prior.rows[0].intent_digest !== digest || prior.rows[0].intent_canonical !== canonical) historyFail('request_reused', 'استُخدم مفتاح الطلب لمحتوى مختلف؛ راجع الطلب الأصلي.', 409);
      await authority.verify(client); authority.assertCurrent();
      callbackCompleted = true; return immutableJson(prior.rows[0].response as HrHistoryReceipt);
    }
    const timeline = await appendHrTimelineInTransaction(client, { kind, subjectKey: String(staffId) }, {
      expectedRevision: command.expectedRevision, reason: command.reason, append: command.append, supersedeIds: command.supersedeIds,
    }, authority);
    const { rows: [record] } = await client.query('SELECT recorded_at::text AS recorded_at FROM hr_effective_revisions WHERE stream_id=$1 AND revision=$2', [stream.id, timeline.revision]);
    const result = immutableJson<HrHistoryReceipt>({ requestId: command.requestId, intentDigest: digest, intent: command, staffId, operation,
      actorUserId: actor.userId, actorUsername: actor.username, recordedAt: record.recorded_at, revision: timeline.revision, timeline, activation: HR_TEMPORAL_ACTIVATION });
    await insertAuditRow(client, { action: 'hr.staff.update', entity: 'hr_effective_revision', entityId: `${stream.id}:${timeline.revision}`,
      entityLabel: `تاريخ الموظف ${staffId}`, actor: actor.username, actorRole: actor.role,
      details: { staffId, operation, revision: timeline.revision, supersedeIds: command.supersedeIds, appendedIds: command.append.map(fact => fact.id), reason: command.reason, intentDigest: digest, activation: HR_TEMPORAL_ACTIVATION } });
    // No hr_staff/current-schedule/financial projection is activated in this slice.
    await client.query(`INSERT INTO hr_temporal_write_receipts(actor_user_id,operation,request_id,staff_id,stream_id,revision,intent_digest,intent_canonical,intent,response)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::text,$8::text::jsonb,$9::jsonb)`, [actor.userId, operation, command.requestId, staffId, stream.id, timeline.revision, digest, canonical, JSON.stringify(result)]);
    await authority.verify(client); authority.assertCurrent();
    callbackCompleted = true; return result;
  }); } catch (error) {
    // A failed COMMIT/response is never labeled a refusal. No automatic new request ID.
    if (!callbackCompleted && (error instanceof HrTemporalError || (error instanceof HrHistoryError && error.status !== 401 && error.status !== 403))) {
      const message = error instanceof HrHistoryError ? error.message : error.code === 'stale_revision'
        ? 'تغيّرت المراجعة؛ أعد التحميل وراجع التصحيح دون الكتابة فوقها.' : `الفترة أو الجدول يحتاج تصحيحًا (${error.code}).`;
      throw new HrHistoryWriteRefusal(error.code, message, error instanceof HrHistoryError ? error.status : error.code === 'stale_revision' ? 409 : 400,
        immutableJson({ intent: command, confirmedNoCommitAttempt: true }));
    }
    throw error;
  }
}
