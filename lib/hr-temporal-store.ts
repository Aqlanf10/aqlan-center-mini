/** Proposal adapter only: caller-owned connection pool, no runtime registration or authority inference. */
import type { Pool, PoolClient } from 'pg';
import { reviseTimeline, temporalFail, validateTimeline, type TemporalChange, type TemporalTimeline } from './hr-temporal';

export interface HrTemporalStream { readonly kind: 'employment' | 'policy' | 'schedule'; readonly subjectKey: string }
function streamKey(stream: HrTemporalStream): void {
  if (!['employment', 'policy', 'schedule'].includes(stream.kind) || typeof stream.subjectKey !== 'string' || !stream.subjectKey.trim() || stream.subjectKey.length > 100) temporalFail('invalid_stream', 'Use an explicit domain and subject identity.');
}
export async function readHrTimeline<T>(source: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>, stream: HrTemporalStream, revision?: number): Promise<TemporalTimeline<T>> {
  streamKey(stream);
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) temporalFail('invalid_revision', 'Invalid recorded revision.');
  if (revision === 0) return validateTimeline({ revision: 0, facts: [] });
  const { rows } = await source.query(`SELECT r.snapshot FROM hr_temporal_stream_proposal s
    JOIN hr_temporal_revision_proposal r ON r.stream_id=s.id AND r.revision=COALESCE($3,s.revision)
    WHERE s.kind=$1 AND s.subject_key=$2`, [stream.kind, stream.subjectKey, revision ?? null]);
  if (!rows.length) {
    if (revision !== undefined) temporalFail('revision_not_found', 'The requested historical revision does not exist.');
    return validateTimeline({ revision: 0, facts: [] });
  }
  return validateTimeline(rows[0].snapshot as TemporalTimeline<T>);
}
/** Integration must provide trusted, transaction-time authorization before enabling any caller. */
export async function appendHrTimeline<T>(pool: Pick<Pool, 'connect'>, stream: HrTemporalStream, change: TemporalChange<T>, actorUserId: number): Promise<TemporalTimeline<T>> {
  streamKey(stream);
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) temporalFail('invalid_actor', 'A recorded actor is required; this is not proof of permission.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO hr_temporal_stream_proposal(kind,subject_key) VALUES($1,$2) ON CONFLICT(kind,subject_key) DO NOTHING', [stream.kind, stream.subjectKey]);
    const { rows: [head] } = await client.query('SELECT id,revision FROM hr_temporal_stream_proposal WHERE kind=$1 AND subject_key=$2 FOR UPDATE', [stream.kind, stream.subjectKey]);
    const current = await readHrTimeline<T>(client, stream);
    if (current.revision !== head.revision) temporalFail('invalid_timeline', 'The stored head has no matching snapshot.');
    const next = reviseTimeline(current, change);
    await client.query(`INSERT INTO hr_temporal_revision_proposal(stream_id,revision,previous_revision,actor_user_id,reason,snapshot)
      VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [head.id, next.revision, current.revision, actorUserId, change.reason, JSON.stringify(next)]);
    await client.query('COMMIT'); return next;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
