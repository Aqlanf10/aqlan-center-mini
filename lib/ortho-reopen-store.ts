/** Explicit same-case reopening. No financial, visit, phase or device mutation. */
import type { DbClient } from './db';
import { insertAuditRow } from './db';
import { assertJourneyCurrent, authorizeJourney, journeyFail, journeyTransaction, lockJourneyOwner, type JourneyOwnerInput } from './ortho-case-journey-authority';
import { canWriteCephClinical } from './ceph-access';
import { requireSession } from './session';
import { canonicalJourneyJSON, journeyContentHash } from './ortho-case-journey-hash';
import { journeyId, type JourneyScope } from './ortho-case-journey-records';
import { PURCHASE_RESET_FENCE, ORTHO_REOPEN_HISTORY_TABLES } from './clinic-reset';
import { isReopenRequestId, readOrthoReopenCommand, type OrthoLifecycleSnapshot, type OrthoReopenCommand, type OrthoReopenRead, type OrthoReopenReceipt, type OrthoReopenTarget } from './ortho-reopen-contract';
interface LifecycleRow {
  lifecycle_version: number; status: OrthoLifecycleSnapshot['status']; phase: OrthoLifecycleSnapshot['phase'];
  closed_at: Date | null; closed_by: string | null; closed_note: string | null;
}
interface EventRow {
  id: number; command_id: string; request_fingerprint: string; command: OrthoReopenCommand;
  actor_user_id: number; created_by: string; created_at: Date; reason: string;
  before_version: number; after_version: number; previous_status: OrthoLifecycleSnapshot['status'];
  previous_phase: OrthoLifecycleSnapshot['phase']; previous_closed_at: Date | null;
  previous_closed_by: string | null; previous_closed_note: string | null; target_status: OrthoReopenTarget;
}
const columns = 'lifecycle_version,status,phase,closed_at,closed_by,closed_note';
function snapshot(row: LifecycleRow): OrthoLifecycleSnapshot {
  return { version: row.lifecycle_version, status: row.status, phase: row.phase,
    closedAt: row.closed_at?.toISOString() ?? null, closedBy: row.closed_by, closedNote: row.closed_note };
}
function receipt(row: EventRow): OrthoReopenReceipt {
  if (journeyContentHash(row.command) !== row.request_fingerprint) journeyFail(500, 'invalid_reopen_receipt');
  return { id: row.id, commandId: row.command_id, requestFingerprint: row.request_fingerprint,
    actorId: row.actor_user_id, createdBy: row.created_by, createdAt: row.created_at.toISOString(), reason: row.reason,
    before: snapshot({ lifecycle_version: row.before_version, status: row.previous_status, phase: row.previous_phase,
      closed_at: row.previous_closed_at, closed_by: row.previous_closed_by, closed_note: row.previous_closed_note }),
    afterVersion: row.after_version, targetStatus: row.target_status };
}
async function finalSession(client: DbClient, input: JourneyOwnerInput) {
  const current = await requireSession(client);
  if (!current || current.expiresAt < Date.now() || current.userId !== input.session.userId
    || current.username !== input.session.username || current.role !== input.session.role) journeyFail(401, 'session_expired');
}
async function prepare(client: DbClient, input: JourneyOwnerInput, write: boolean, clinicalCaseId?: number) {
  await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [PURCHASE_RESET_FENCE]);
  await client.query(`LOCK TABLE ${ORTHO_REOPEN_HISTORY_TABLES.join(',')} IN ROW EXCLUSIVE MODE`);
  const authority = await authorizeJourney(client, input, write);
  if (!canWriteCephClinical(authority.session.role)) journeyFail(403, 'clinical_access_denied');
  const owner = await lockJourneyOwner(client, input, write);
  if (clinicalCaseId !== undefined && owner.clinicalCaseId !== clinicalCaseId) journeyFail(409, 'case_scope_changed');
  const row = (await client.query<LifecycleRow>(`SELECT ${columns} FROM ortho_cases WHERE id=$1`, [owner.orthoCaseId])).rows[0];
  assertJourneyCurrent(authority);
  return { authority, scope: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId } satisfies JourneyScope, row };
}
export async function readOrthoReopen(input: JourneyOwnerInput & { requestId?: string; after?: number }) {
  return journeyTransaction(false, async client => {
    if (input.requestId !== undefined && !isReopenRequestId(input.requestId)
      || input.after !== undefined && !journeyId(input.after)) journeyFail(400, 'invalid_reopen_query');
    const { scope, row, authority } = await prepare(client, input, false);
    const history = (await client.query<EventRow>(`SELECT * FROM ortho_case_reopen_events WHERE ortho_case_id=$1
      AND ($2::integer IS NULL OR id<$2) ORDER BY id DESC LIMIT 25`, [scope.orthoCaseId, input.after ?? null])).rows;
    const recovered = input.requestId === undefined ? null : (await client.query<EventRow>(
      'SELECT * FROM ortho_case_reopen_events WHERE patient_id=$1 AND ortho_case_id=$2 AND actor_user_id=$3 AND command_id=$4',
      [scope.patientId, scope.orthoCaseId, authority.userId, input.requestId])).rows[0] ?? null;
    await finalSession(client, input);
    return { ok: true as const, scope, actorId: authority.userId, current: snapshot(row), history: history.map(receipt),
      next: history.length === 25 ? history.at(-1)!.id : null, receipt: recovered ? receipt(recovered) : null } satisfies OrthoReopenRead;
  });
}
export async function reopenOrthoCase(input: JourneyOwnerInput & { clinicalCaseId: number; command: unknown }) {
  let command: OrthoReopenCommand;
  try { command = readOrthoReopenCommand(input.command); } catch { return { ok: false as const, status: 400, code: 'invalid_reopen_command', message: 'طلب إعادة فتح الحالة غير صالح.' }; }
  if (!journeyId(input.clinicalCaseId)) return { ok: false as const, status: 400, code: 'invalid_scope', message: 'هوية الحالة غير صالحة.' };
  return journeyTransaction(true, async client => {
    const { scope, row, authority } = await prepare(client, input, true, input.clinicalCaseId);
    const fingerprint = journeyContentHash(command);
    // Replay precedes lifecycle/CAS tests: later closure never repeats this command.
    const prior = (await client.query<EventRow & { ortho_case_id: number; clinical_case_id: number }>(
      'SELECT * FROM ortho_case_reopen_events WHERE patient_id=$1 AND actor_user_id=$2 AND command_id=$3',
      [scope.patientId, authority.userId, command.clientRequestId])).rows[0];
    if (prior) {
      if (prior.ortho_case_id !== scope.orthoCaseId || prior.clinical_case_id !== scope.clinicalCaseId || prior.request_fingerprint !== fingerprint) journeyFail(409, 'request_key_conflict');
      await finalSession(client, input);
      return { ok: true as const, scope, actorId: authority.userId, receipt: receipt(prior), current: snapshot(row), replayed: true };
    }
    if (row.lifecycle_version !== command.expectedLifecycleVersion || row.status !== command.expectedStatus) journeyFail(409, 'reopen_state_changed');
    if (row.status !== 'completed' && row.status !== 'discontinued') journeyFail(409, 'case_not_closed');
    // Assessment's null treatment shape is enforced by0108. Do not manufacture
    // appliance/start dates or infer active/retention from the recorded phase.
    if ((row.phase === 'assessment') !== (command.targetStatus === 'assessment')
      || row.phase === 'assessment' && row.status !== 'discontinued') journeyFail(409, 'reopen_target_incompatible');
    const other = await client.query("SELECT id FROM ortho_cases WHERE patient_id=$1 AND id<>$2 AND status IN ('assessment','active','retention') LIMIT 1", [scope.patientId, scope.orthoCaseId]);
    if (other.rows.length) journeyFail(409, 'another_ortho_case_open');
    // INSERT...SELECT copies PostgreSQL timestamp precision and nullable legacy
    // evidence directly; display ISO strings are never written back as history.
    const event = (await client.query<EventRow>(`INSERT INTO ortho_case_reopen_events(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,
      actor_user_id,created_by,command_id,request_fingerprint,command,reason,before_version,after_version,
      previous_status,previous_phase,previous_closed_at,previous_closed_by,previous_closed_note,target_status)
      SELECT patient_id,patient_id,id,$2,$3,$4,$5,$6,$7::jsonb,$8,lifecycle_version,lifecycle_version+1,status,phase,closed_at,closed_by,closed_note,$9
      FROM ortho_cases WHERE id=$1 RETURNING *`,
    [scope.orthoCaseId, scope.clinicalCaseId, authority.userId, authority.session.username, command.clientRequestId, fingerprint,
      canonicalJourneyJSON(command), command.reason, command.targetStatus])).rows[0];
    const changed = (await client.query<LifecycleRow>(`UPDATE ortho_cases SET status=$2,closed_at=NULL,closed_by=NULL,closed_note=NULL
      WHERE id=$1 AND lifecycle_version=$3 RETURNING ${columns}`, [scope.orthoCaseId, command.targetStatus, command.expectedLifecycleVersion])).rows[0];
    if (!changed) journeyFail(409, 'reopen_state_changed');
    await insertAuditRow(client, { action: 'ortho.reopen', entity: 'ortho_cases', entityId: scope.orthoCaseId,
      actor: authority.session.username, actorRole: authority.session.role,
      details: { patientId: scope.patientId, eventId: event.id, fromStatus: row.status, toStatus: command.targetStatus,
        beforeVersion: row.lifecycle_version, afterVersion: changed.lifecycle_version } });
    await finalSession(client, input);
    return { ok: true as const, scope, actorId: authority.userId, receipt: receipt(event), current: snapshot(changed), replayed: false };
  });
}
