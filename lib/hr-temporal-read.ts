import { operationalEmployment } from "./hr-operational-employment-shared";
import type { EmploymentFact } from "./hr-effective-policy";
import type { DbClient, DbPool } from './db';
import { CLINIC_TIME_ZONE } from './db';
import { withIsolation } from './transactions';
import { assertDay, immutableJson, selectTemporal, type TemporalTimeline } from './hr-temporal';
import { readHrTimeline } from './hr-temporal-store';
import { requireHrHistorySchema, HR_TEMPORAL_ACTIVATION } from './hr-temporal-write';
import { requireHrTemporalAuthority, type HrTemporalAuthority } from './hr-temporal-authority';
import { historyFail, type HrHistoryKind, type HrHistoryValue } from './hr-temporal-request';
import type { HrEffectivePolicy, HrEffectivePolicyKey } from './hr-effective-policy';

export async function withHrHistoryRead<T>(pool: DbPool, authority: HrTemporalAuthority, work: (client: DbClient) => Promise<T>): Promise<T> {
  requireHrTemporalAuthority(authority);
  return withIsolation(pool, 'REPEATABLE READ', async client => {
    await authority.verify(client); await requireHrHistorySchema(client);
    const result = await work(client);
    await authority.verify(client); authority.assertCurrent(); return result;
  });
}
export async function readHrStaffScope(client: DbClient, staffId: number) {
  if (!Number.isSafeInteger(staffId) || staffId < 1 || staffId > 2147483647) historyFail('invalid_subject', 'رقم الموظف غير صالح.', 400);
  const { rows: [staff] } = await client.query(`SELECT *,hire_date::text AS hire_date,end_date::text AS end_date,
    salary_effective_on::text AS salary_effective_on FROM hr_staff WHERE id=$1 FOR SHARE`, [staffId]);
  if (!staff) historyFail('staff_not_found', 'ملف الموظف غير موجود.', 404);
  return staff;
}
export async function readHrRecordedHistory(pool: DbPool, authority: HrTemporalAuthority, staffId: number, kind: HrHistoryKind, options: { revision?: number; day?: string } = {}) {
  if (!['employment', 'schedule'].includes(kind)) historyFail('invalid_operation', 'نوع التاريخ غير صالح.', 400);
  if (options.day !== undefined) assertDay(options.day);
  return withHrHistoryRead(pool, authority, async client => {
    const staff = await readHrStaffScope(client, staffId), stream = { kind, subjectKey: String(staffId) };
    const head = await readHrTimeline<HrHistoryValue>(client, stream);
    const timeline = options.revision === undefined ? head : await readHrTimeline<HrHistoryValue>(client, stream, options.revision);
    const { rows: [clock] } = await client.query('SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS day', [CLINIC_TIME_ZONE]);
    const day = options.day ?? clock.day;
    const metadataSql = `SELECT r.revision,r.previous_revision,r.actor_user_id,r.reason,r.recorded_at::text,
      ARRAY(SELECT f->>'id' FROM jsonb_array_elements(r.snapshot->'facts') f) AS fact_ids,
      ARRAY(SELECT f->>'id' FROM jsonb_array_elements(p.snapshot->'facts') f) AS previous_fact_ids
      FROM hr_effective_streams s JOIN hr_effective_revisions r ON r.stream_id=s.id
      LEFT JOIN hr_effective_revisions p ON p.stream_id=r.stream_id AND p.revision=r.previous_revision
      WHERE s.kind=$1 AND s.subject_key=$2 AND ($3::int IS NULL OR r.revision=$3) ORDER BY r.revision DESC LIMIT 51`;
    const { rows } = await client.query(metadataSql, [kind, String(staffId), null]);
    const selectedRows = timeline.revision > 0 && !rows.slice(0, 50).some(row => row.revision === timeline.revision)
      ? (await client.query(metadataSql, [kind, String(staffId), timeline.revision])).rows : [];
    const metadata = (row: typeof rows[number]) => ({ revision: row.revision, previousRevision: row.previous_revision, actorUserId: row.actor_user_id,
      recordedAt: row.recorded_at, reason: row.reason,
      appendedIds: (row.fact_ids as string[]).filter(id => !(row.previous_fact_ids as string[]).includes(id)),
      supersededIds: (row.previous_fact_ids as string[]).filter(id => !(row.fact_ids as string[]).includes(id)) });
    const records = rows.slice(0, 50).map(metadata);
    const selectedRecord = records.find(record => record.revision === timeline.revision) ?? (selectedRows[0] ? metadata(selectedRows[0]) : null);
    return immutableJson({ staffId, fullName: staff.full_name, kind, headRevision: head.revision, timeline, records, selectedRecord, hasMoreRecords: rows.length > 50,
      asOfDay: day, selected: selectTemporal(timeline, day), activation: HR_TEMPORAL_ACTIVATION,
      legacyObservation: { kind: 'unknown' as const, source: 'current_profile_without_effective_proof', workStatus: staff.work_status,
        hireDate: staff.hire_date, endDate: staff.end_date, linkedUserId: staff.user_id },
      operationalEmployment: kind === 'employment' ? operationalEmployment(staff.work_status, head as TemporalTimeline<EmploymentFact>, clock.day) : null,
      warning: kind === 'employment' ? 'الحالة التشغيلية من أحدث مراجعة ويوم العيادة؛ الفجوات غير معروفة. التاريخ لا يحسب أجرًا أو خصمًا.' : 'الجدول موثق للمراجعة فقط؛ لا يغيّر حساب الحضور أو مبلغ الأجر.' });
  });
}
export async function readHrPolicyHistories(client: DbClient): Promise<Record<HrEffectivePolicyKey, TemporalTimeline<HrEffectivePolicy>>> {
  const result = {} as Record<HrEffectivePolicyKey, TemporalTimeline<HrEffectivePolicy>>;
  // Deterministic order within the same consistent snapshot; no approval is inferred.
  for (const key of ['employment_pay_effect', 'leave_entitlement', 'proration'] as const) result[key] = await readHrTimeline<HrEffectivePolicy>(client, { kind: 'policy', subjectKey: key });
  return result;
}
export type HrRecordedHistory = Awaited<ReturnType<typeof readHrRecordedHistory>>;
