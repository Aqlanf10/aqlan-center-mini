/** Integration adapter only: caller-owned pool, no runtime registration or authority inference. */
import type { Pool, PoolClient } from 'pg';
import { reviseTimeline, temporalFail, validateTimeline, type TemporalChange, type TemporalTimeline } from './hr-temporal';
import { validateEffectivePolicy, type HrEffectivePolicy, type HrEffectivePolicyKey } from './hr-effective-policy';
import { validateEffectiveSchedule, type HrEffectiveSchedule } from './hr-schedule-segments';

export interface HrTemporalStream { readonly kind: 'employment' | 'policy' | 'schedule'; readonly subjectKey: string }
function streamKey(stream: HrTemporalStream): void {
  if (!['employment', 'policy', 'schedule'].includes(stream.kind) || typeof stream.subjectKey !== 'string' || !stream.subjectKey.trim() || stream.subjectKey.length > 100) temporalFail('invalid_stream', 'Use an explicit domain and subject identity.');
  if (stream.kind === 'policy') {
    if (!['employment_pay_effect', 'proration', 'leave_entitlement'].includes(stream.subjectKey)) temporalFail('invalid_stream', 'Unknown policy key.');
  } else if (!/^[1-9]\d*$/.test(stream.subjectKey) || Number(stream.subjectKey) > 2147483647) temporalFail('invalid_stream', 'Use the canonical staff ID, independently of a login or treating-doctor identity.');
}
function validateValues<T>(timeline: TemporalTimeline<T>, stream: HrTemporalStream): TemporalTimeline<T> {
  const copy = validateTimeline(timeline);
  for (const fact of copy.facts) {
    if (stream.kind === 'employment' && (!fact.value || typeof fact.value !== 'object' || !('status' in fact.value) || typeof fact.value.status !== 'string' || !['active', 'suspended', 'ended'].includes(fact.value.status))) temporalFail('invalid_employment', 'Unknown employment status.');
    if (stream.kind === 'policy') validateEffectivePolicy(fact.value as HrEffectivePolicy, stream.subjectKey as HrEffectivePolicyKey);
    if (stream.kind === 'schedule' && fact.kind === 'known') validateEffectiveSchedule(fact.value as HrEffectiveSchedule);
  }
  return copy;
}
export async function readHrTimeline<T>(source: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, stream: HrTemporalStream, revision?: number): Promise<TemporalTimeline<T>> {
  streamKey(stream);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) temporalFail('invalid_revision', 'Invalid recorded revision.');
  if (revision === 0) return validateTimeline({ revision: 0, facts: [] });
  const { rows } = await source.query(`SELECT r.snapshot FROM hr_effective_streams s
    JOIN hr_effective_revisions r ON r.stream_id=s.id
    WHERE s.kind=$1 AND s.subject_key=$2 AND ($3::int IS NULL OR r.revision=$3)
    ORDER BY r.revision DESC LIMIT 1`, [stream.kind, stream.subjectKey, revision ?? null]);
  if (!rows.length) {
    if (revision !== undefined) temporalFail('revision_not_found', 'The requested historical revision does not exist.');
    return validateTimeline({ revision: 0, facts: [] });
  }
  return validateValues(rows[0].snapshot as TemporalTimeline<T>, stream);
}
/** Integration must provide trusted, transaction-time authorization before enabling any caller. */
export async function appendHrTimeline<T>(pool: Pick<Pool, 'connect'>, stream: HrTemporalStream, change: TemporalChange<T>, actorUserId: number): Promise<TemporalTimeline<T>> {
  streamKey(stream);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) temporalFail('invalid_actor', 'A recorded actor is required; this is not proof of permission.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO hr_effective_streams(kind,subject_key,staff_id) VALUES($1,$2,$3) ON CONFLICT(kind,subject_key) DO NOTHING', [stream.kind, stream.subjectKey, stream.kind === 'policy' ? null : Number(stream.subjectKey)]);
    const { rows: [head] } = await client.query('SELECT id FROM hr_effective_streams WHERE kind=$1 AND subject_key=$2 FOR UPDATE', [stream.kind, stream.subjectKey]);
    const current = await readHrTimeline<T>(client, stream);
    const next = validateValues(reviseTimeline(current, change), stream);
    await client.query(`INSERT INTO hr_effective_revisions(stream_id,revision,previous_revision,actor_user_id,reason,snapshot)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [head.id, next.revision, current.revision, actorUserId, change.reason, JSON.stringify(next)]);
    await client.query('COMMIT'); return next;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
