import { CLINIC_TIME_ZONE, type DbClient } from './db';
import type { EmploymentFact } from './hr-effective-policy';
import { historyFail } from './hr-temporal-request';
import { validateTimeline, type TemporalTimeline } from './hr-temporal';
import { operationalEmployment } from './hr-operational-employment-shared';
import type { HrWorkStatus } from './hr-shared';

/** Readers use one repeatable snapshot. Writers call after the existing staff lock. */
export async function readOperationalEmployment(client: Pick<DbClient, 'query'>, staffIds: readonly number[]) {
  const { rows: [schema] } = await client.query(`SELECT to_regclass('public.hr_effective_streams') IS NOT NULL AS streams,
    to_regclass('public.hr_effective_revisions') IS NOT NULL AS revisions`);
  if (Boolean(schema.streams) !== Boolean(schema.revisions)) historyFail('integration_pending', 'مخطط تاريخ الموظفين غير مكتمل؛ تعذّر التحقق من الحالة.', 503);
  // clock_timestamp (not transaction NOW) is intentionally sampled AFTER any lock wait.
  const { rows: [snapshot] } = await client.query(`WITH clock AS MATERIALIZED (SELECT (clock_timestamp() AT TIME ZONE $1)::date::text AS day)
    SELECT clock.day, ${schema.streams ? `(SELECT COALESCE(jsonb_object_agg(s.staff_id, r.snapshot), '{}'::jsonb)
      FROM hr_effective_streams s CROSS JOIN LATERAL (SELECT snapshot FROM hr_effective_revisions
        WHERE stream_id=s.id ORDER BY revision DESC LIMIT 1) r
      WHERE s.kind='employment' AND s.staff_id=ANY($2::int[]))` : `'{}'::jsonb`} AS timelines FROM clock`,
    schema.streams ? [CLINIC_TIME_ZONE, staffIds] : [CLINIC_TIME_ZONE]);
  const timelines = snapshot.timelines as Record<string, TemporalTimeline<EmploymentFact>>;
  const timeline = (id: number) => validateTimeline(timelines[id] ?? { revision: 0, facts: [] });
  return { day: String(snapshot.day), timeline,
    forStaff: (staff: { id: number; work_status: HrWorkStatus }) => operationalEmployment(staff.work_status, timeline(staff.id), String(snapshot.day)) };
}
