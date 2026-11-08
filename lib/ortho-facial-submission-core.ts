/** INACTIVE durable intent kernel. Reserve and execute MUST have two different
 * caller-owned committed lifetimes. There is deliberately no combined wrapper.
 * Execution's revision, journal settlement and audits share its one transaction. */
import { journeyContentHash, canonicalJourneyJSON } from './ortho-case-journey-hash';
import { readFacialCommand, type FacialCommand } from './ortho-facial-analysis';
import type { FacialSubmissionIdentity, FacialSubmissionRecovery } from './ortho-facial-submission-contract';
import {
  FacialFault, facialFail, facialId, facialHash, facialScope, facialQuery, facialOperationData, assertFacialOperation, facialEligibility,
  openFacialOperation, closeFacialOperation, appendFacialAudit, pinFacialConfiguration,
  type FacialSnapshotReadPorts, type FacialDocumentSource, type FacialScope, type FacialQuery, type FacialCorePorts, type FacialWritePorts, type FacialReadPorts, type FacialOperation, type FacialOwner,
} from './ortho-facial-core-contract';
import {
  parseFacialCoreCommand, readFacialSourceWith, readFacialOwnerWith, prepareFacialRevisionWith, inspectFacialPreparation, appendPreparedFacialRevisionWith,
} from './ortho-facial-revision-core';
import { FACIAL_READ_BYTES, boundFacialRead, copyFacialReadSource, guardFacialRecoveryRows } from './ortho-facial-read-witness';
interface SubmissionRow {
  id: number; patient_id: number; recorded_patient_id: number; ortho_case_id: number; clinical_case_id: number;
  actor_user_id: number; document_id: number | null; command_id: string; request_fingerprint: string;
  command: unknown | null; previous_version: number | null; state: 'pending' | 'committed' | 'cancelled';
  revision_id: number | null; acknowledged_at: Date | null;
}
export interface FacialSubmissionRequest extends FacialScope { clinicalCaseId: number; actorId: number; command: unknown }
export interface FacialSubmissionTransition extends FacialScope {
  clinicalCaseId: number; actorId: number; commandId: string; requestFingerprint: string; action: 'acknowledge' | 'cancel';
}
const commandIdValid = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
function envelope(row: SubmissionRow | undefined): SubmissionRow | null {
  if (!row) return null;
  if (![row.id, row.patient_id, row.recorded_patient_id, row.ortho_case_id, row.clinical_case_id, row.actor_user_id].every(facialId)
    || !commandIdValid(row.command_id) || !facialHash(row.request_fingerprint) || !['pending', 'committed', 'cancelled'].includes(row.state)
    || !(row.document_id === null || facialId(row.document_id)) || !(row.revision_id === null || facialId(row.revision_id))
    || !(row.previous_version === null || Number.isSafeInteger(row.previous_version) && row.previous_version >= 0)
    || !(row.acknowledged_at === null || row.acknowledged_at instanceof Date && Number.isFinite(row.acknowledged_at.getTime()))
    || (row.state === 'committed') !== (row.revision_id !== null)
    || row.state === 'pending' && row.acknowledged_at !== null
    || row.acknowledged_at !== null && row.command !== null
    || row.document_id === null && (row.state !== 'cancelled' || row.command !== null || row.previous_version !== null)
    || row.document_id !== null && (row.previous_version === null || row.acknowledged_at === null && row.command === null)) facialFail(500, 'invalid_facial_submission');
  return row;
}
const identity = (row: SubmissionRow): FacialSubmissionIdentity => ({ id: row.id, commandId: row.command_id, requestFingerprint: row.request_fingerprint });
const outputScope = (owner: FacialOwner) => ({ patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, clinicalCaseId: owner.clinicalCaseId });
function sameOriginal(row: SubmissionRow, owner: FacialOwner, actor: number) {
  return row.actor_user_id === actor && row.patient_id === owner.patientId && row.recorded_patient_id === owner.patientId && row.ortho_case_id === owner.orthoCaseId && row.clinical_case_id === owner.clinicalCaseId;
}
function currentContext(row: SubmissionRow, owner: FacialOwner, actor: number) {
  return row.actor_user_id === actor && row.patient_id === owner.patientId && row.ortho_case_id === owner.orthoCaseId && row.clinical_case_id === owner.clinicalCaseId
    && (row.acknowledged_at !== null || sameOriginal(row, owner, actor));
}
function decode(row: SubmissionRow): FacialCommand {
  let command: FacialCommand;
  try { command = readFacialCommand(row.command); } catch { facialFail(500, 'invalid_facial_submission'); }
  if (command.clientRequestId !== row.command_id || command.documentId !== row.document_id || journeyContentHash(command) !== row.request_fingerprint
    || !Number.isSafeInteger(row.previous_version) || row.previous_version! < 0 || (command.expectedHeadId === null) !== (row.previous_version === 0)) facialFail(500, 'invalid_facial_submission');
  return command;
}
async function fence(client: FacialQuery, ports: FacialCorePorts, configuration: () => void) {
  configuration();
  if (ports.mode === 'snapshot-read') return;
  await client.query('LOCK TABLE ortho_facial_revisions IN ROW EXCLUSIVE MODE');
  configuration();
  await client.query('LOCK TABLE ortho_facial_submissions IN ROW EXCLUSIVE MODE');
  configuration();
}
function rowLock(ports: FacialCorePorts) {
  return ports.mode === 'snapshot-read' ? '' : `FOR UPDATE${ports.mode === 'write' && ports.locking === 'nowait' ? ' NOWAIT' : ''}`;
}
async function find(operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts, commandId: string) {
  const { actor, scope } = facialOperationData(operation, client, ports);
  const row = envelope((await facialQuery<SubmissionRow>(operation, client, ports,
    `SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3 ${rowLock(ports)}`, [scope.orthoCaseId, actor.userId, commandId])).rows[0]);
  if (row && (row.ortho_case_id !== scope.orthoCaseId || row.actor_user_id !== actor.userId || row.command_id !== commandId)) facialFail(500, 'invalid_facial_submission');
  return row;
}
async function outstanding(operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts, beforeSnapshot?: (rows: readonly SubmissionRow[]) => void) {
  const { scope } = facialOperationData(operation, client, ports);
  const rows = (await facialQuery<SubmissionRow>(operation, client, ports,
    `SELECT * FROM ortho_facial_submissions WHERE ortho_case_id=$1 AND acknowledged_at IS NULL ${rowLock(ports)}`, [scope.orthoCaseId], false, beforeSnapshot)).rows;
  if (rows.length > 1) facialFail(500, 'invalid_facial_submission');
  const row = envelope(rows[0]);
  if (row && (row.ortho_case_id !== scope.orthoCaseId || row.acknowledged_at !== null)) facialFail(500, 'invalid_facial_submission');
  return row;
}
async function audit(operation: FacialOperation, client: FacialQuery, ports: FacialWritePorts, row: SubmissionRow, event: 'reserved' | 'committed' | 'cancelled_before_arrival' | 'cancelled' | 'acknowledged', images: boolean) {
  const { actor } = facialOperationData(operation, client, ports);
  await appendFacialAudit(operation, client, ports, { actor, action: 'ortho.facial_submission', entity: 'ortho_facial_submissions', entityId: row.id,
    details: { event, orthoCaseId: row.ortho_case_id, requestFingerprint: row.request_fingerprint, state: row.state } }, images);
}
function requestScope(input: { clinicalCaseId: number; actorId: number }, code: 'invalid_facial_submission_scope' | 'invalid_facial_submission_transition') {
  if (!facialId(input.clinicalCaseId) || !facialId(input.actorId)) facialFail(400, code);
}
async function bind(operation: FacialOperation, client: FacialQuery, ports: FacialWritePorts, expected: { clinicalCaseId: number; actorId: number }) {
  const { actor } = facialOperationData(operation, client, ports);
  if (actor.userId !== expected.actorId) facialFail(409, 'facial_submission_actor_changed');
  const owner = await readFacialOwnerWith(operation, client, ports, { discovery: true });
  if (owner.clinicalCaseId !== expected.clinicalCaseId) facialFail(409, 'facial_submission_context_changed');
  return actor;
}
function requireRow(row: SubmissionRow | undefined) { const result = envelope(row); if (!result) facialFail(500, 'invalid_facial_submission'); return result; }
function insertedContext(row: SubmissionRow, owner: FacialOwner, actor: number, commandId: string, hash: string) {
  if (!sameOriginal(row, owner, actor) || row.command_id !== commandId || row.request_fingerprint !== hash) facialFail(500, 'invalid_facial_submission');
}
function stableIdentity(before: SubmissionRow, after: SubmissionRow) {
  if (['id', 'patient_id', 'recorded_patient_id', 'ortho_case_id', 'clinical_case_id', 'actor_user_id', 'document_id', 'command_id', 'request_fingerprint', 'previous_version'].some(key => before[key as keyof SubmissionRow] !== after[key as keyof SubmissionRow])) facialFail(500, 'invalid_facial_submission');
}
export async function reserveFacialSubmissionWith(client: FacialQuery, input: FacialSubmissionRequest, ports: FacialWritePorts) {
  requestScope(input, 'invalid_facial_submission_scope');
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const expected = { clinicalCaseId: input.clinicalCaseId, actorId: input.actorId }, command = parseFacialCoreCommand(input.command), hash = journeyContentHash(command);
  const pinnedScope = facialScope(input), configuration = pinFacialConfiguration(client, ports);
  await fence(client, ports, configuration);
  configuration();
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const operation = await openFacialOperation(client, pinnedScope, ports);
  try {
    const actor = await bind(operation, client, ports, expected), existing = await find(operation, client, ports, command.clientRequestId);
    if (existing) {
      if (existing.request_fingerprint !== hash) facialFail(409, 'request_key_conflict');
      const owner = await readFacialOwnerWith(operation, client, ports, { write: false });
      if (owner.clinicalCaseId !== expected.clinicalCaseId || !currentContext(existing, owner, actor.userId)) facialFail(409, 'facial_submission_context_changed');
      if (existing.state === 'cancelled') facialFail(409, 'facial_submission_cancelled');
      await assertFacialOperation(operation, client, ports);
      return { ok: true as const, identity: identity(existing) };
    }
    if (await outstanding(operation, client, ports)) facialFail(409, 'facial_submission_unacknowledged');
    const prepared = await prepareFacialRevisionWith(operation, client, ports, command);
    const { owner, replayId, previousVersion } = await inspectFacialPreparation(prepared, operation, client, ports);
    if (owner.clinicalCaseId !== expected.clinicalCaseId) facialFail(409, 'facial_submission_context_changed');
    const row = requireRow((await facialQuery<SubmissionRow>(operation, client, ports,
      `INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state,revision_id,settled_at,document_id)
       VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,CASE WHEN $10::integer IS NULL THEN NULL ELSE clock_timestamp() END,$11) RETURNING *`,
      [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, actor.userId, command.clientRequestId, hash, canonicalJourneyJSON(command), previousVersion, replayId === null ? 'pending' : 'committed', replayId, command.documentId], true)).rows[0]);
    insertedContext(row, owner, actor.userId, command.clientRequestId, hash);
    if (row.revision_id !== replayId || row.previous_version !== previousVersion || row.document_id !== command.documentId || row.acknowledged_at !== null) facialFail(500, 'invalid_facial_submission');
    decode(row);
    await audit(operation, client, ports, row, 'reserved', true);
    await assertFacialOperation(operation, client, ports, true);
    return { ok: true as const, identity: identity(row) };
  } finally { closeFacialOperation(operation); }
}
export async function executeReservedFacialWith(client: FacialQuery, input: FacialSubmissionRequest, ports: FacialWritePorts) {
  requestScope(input, 'invalid_facial_submission_scope');
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const expected = { clinicalCaseId: input.clinicalCaseId, actorId: input.actorId }, command = parseFacialCoreCommand(input.command), hash = journeyContentHash(command);
  const pinnedScope = facialScope(input), configuration = pinFacialConfiguration(client, ports);
  await fence(client, ports, configuration);
  configuration();
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const operation = await openFacialOperation(client, pinnedScope, ports);
  try {
    const actor = await bind(operation, client, ports, expected), row = await find(operation, client, ports, command.clientRequestId);
    if (!row || row.request_fingerprint !== hash) facialFail(409, 'request_key_conflict');
    if (row.state === 'cancelled') facialFail(409, 'facial_submission_cancelled');
    const persisted = row.command === null ? command : decode(row);
    const prepared = await prepareFacialRevisionWith(operation, client, ports, persisted);
    const { owner } = await inspectFacialPreparation(prepared, operation, client, ports);
    if (owner.clinicalCaseId !== expected.clinicalCaseId || !currentContext(row, owner, actor.userId)) facialFail(409, 'facial_submission_context_changed');
    const result = await appendPreparedFacialRevisionWith(prepared, operation, client, ports);
    if (row.state === 'pending') {
      const settled = requireRow((await facialQuery<SubmissionRow>(operation, client, ports,
        "UPDATE ortho_facial_submissions SET state='committed',revision_id=$2,settled_at=clock_timestamp() WHERE id=$1 RETURNING *", [row.id, result.revision.id], true)).rows[0]);
      stableIdentity(row, settled);
      if (settled.state !== 'committed' || settled.revision_id !== result.revision.id || settled.acknowledged_at !== null || canonicalJourneyJSON(settled.command) !== canonicalJourneyJSON(row.command)) facialFail(500, 'facial_submission_result_mismatch');
      await audit(operation, client, ports, settled, 'committed', true);
    } else if (row.revision_id !== result.revision.id) facialFail(500, 'facial_submission_result_mismatch');
    await assertFacialOperation(operation, client, ports, true);
    return result;
  } finally { closeFacialOperation(operation); }
}
const recoverable = new Set<FacialFault['code']>(['invalid_facial_analysis', 'invalid_image_date', 'facial_document_unavailable', 'facial_image_changed', 'facial_image_unsupported', 'facial_image_integrity', 'facial_image_decode', 'image_access_denied', 'facial_head_changed', 'request_key_conflict', 'facial_submission_context_changed']);
/** Internal inert snapshot discovery. The caller still owns commit/release. */
type RecoveryMetadata = Omit<FacialSubmissionRecovery, 'recovery'> & {
  recovery: Exclude<FacialSubmissionRecovery['recovery'], { state: 'pending' | 'committed' }>;
};
export type FacialRecoveryRow = Readonly<Omit<SubmissionRow, 'command' | 'acknowledged_at' | 'state'> & {
  command: FacialCommand; acknowledged_at: null; state: 'pending' | 'committed';
}>;
export type FacialRecoveryDiscovery =
  | { readonly kind: 'metadata'; readonly response: RecoveryMetadata }
  | { readonly kind: 'needs-image'; readonly owner: FacialOwner; readonly row: FacialRecoveryRow; readonly source: FacialDocumentSource };
function freezeRecoveryPlain<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeRecoveryPlain(child);
    Object.freeze(value);
  }
  return value;
}
export async function discoverFacialRecoveryWith(client: FacialQuery, input: FacialScope, ports: FacialSnapshotReadPorts): Promise<FacialRecoveryDiscovery> {
  if (ports.mode !== 'snapshot-read') facialFail(500, 'facial_core_context_changed');
  const pinnedScope = facialScope(input), configuration = pinFacialConfiguration(client, ports);
  configuration();
  const operation = await openFacialOperation(client, pinnedScope, ports);
  try {
    const { actor } = facialOperationData(operation, client, ports);
    const row = await outstanding(operation, client, ports, guardFacialRecoveryRows);
    const discovered = await readFacialOwnerWith(operation, client, ports, { discovery: true });
    const metadata = (owner: FacialOwner, recovery: RecoveryMetadata['recovery']): FacialRecoveryDiscovery => {
      const response: RecoveryMetadata = { ok: true, actorId: actor.userId, scope: outputScope(owner), recovery };
      boundFacialRead(response, FACIAL_READ_BYTES.witness);
      return freezeRecoveryPlain({ kind: 'metadata' as const, response });
    };
    if (!row || !sameOriginal(row, discovered, actor.userId) || row.state === 'cancelled') {
      const owner = await readFacialOwnerWith(operation, client, ports);
      await assertFacialOperation(operation, client, ports);
      if (!row) return metadata(owner, null);
      if (!sameOriginal(row, owner, actor.userId) || !sameOriginal(row, discovered, actor.userId)) return metadata(owner, { state: 'blocked', identity: null, canCancel: false });
      return metadata(owner, { state: 'cancelled', identity: identity(row) });
    }
    // Actual private strict decode, outside the recoverable preparation branch.
    const command = freezeRecoveryPlain(decode(row));
    try {
      await assertFacialOperation(operation, client, ports, true);
      const source = copyFacialReadSource(await readFacialSourceWith(operation, client, ports, command.documentId));
      const owner = await readFacialOwnerWith(operation, client, ports);
      if (!sameOriginal(row, owner, actor.userId)) facialFail(409, 'facial_submission_context_changed');
      await assertFacialOperation(operation, client, ports, true);
      boundFacialRead({ source, owner }, FACIAL_READ_BYTES.witness);
      const projected: FacialRecoveryRow = { id: row.id, patient_id: row.patient_id, recorded_patient_id: row.recorded_patient_id,
        ortho_case_id: row.ortho_case_id, clinical_case_id: row.clinical_case_id, actor_user_id: row.actor_user_id,
        document_id: row.document_id, command_id: row.command_id, request_fingerprint: row.request_fingerprint,
        command, previous_version: row.previous_version, state: row.state, revision_id: row.revision_id, acknowledged_at: null };
      const result = freezeRecoveryPlain({ kind: 'needs-image' as const, owner, row: projected, source });
      boundFacialRead(result, FACIAL_READ_BYTES.recovery);
      return result;
    } catch (error) {
      if (!(error instanceof FacialFault) || ![400, 403, 404, 409].includes(error.status) || !recoverable.has(error.code)) throw error;
      const owner = await readFacialOwnerWith(operation, client, ports);
      const canCancel = sameOriginal(row, owner, actor.userId) && row.state === 'pending' && await facialEligibility(operation, client, ports);
      await assertFacialOperation(operation, client, ports);
      return metadata(owner, { state: 'blocked', identity: canCancel ? identity(row) : null, canCancel });
    }
  } finally { closeFacialOperation(operation); }
}
export async function readFacialSubmissionRecoveryWith(client: FacialQuery, input: FacialScope, ports: FacialReadPorts): Promise<FacialSubmissionRecovery> {
  if (ports.mode !== 'legacy-read' && ports.mode !== 'snapshot-read') facialFail(500, 'facial_core_context_changed');
  const pinnedScope = facialScope(input), configuration = pinFacialConfiguration(client, ports);
  await fence(client, ports, configuration);
  configuration();
  const operation = await openFacialOperation(client, pinnedScope, ports);
  try {
    const { actor } = facialOperationData(operation, client, ports);
    const row = await outstanding(operation, client, ports), discovered = await readFacialOwnerWith(operation, client, ports, { discovery: true });
    const output = (owner: FacialOwner, recovery: FacialSubmissionRecovery['recovery']): FacialSubmissionRecovery => ({ ok: true, actorId: actor.userId, scope: outputScope(owner), recovery });
    if (!row || !sameOriginal(row, discovered, actor.userId) || row.state === 'cancelled') {
      const owner = await readFacialOwnerWith(operation, client, ports);
      await assertFacialOperation(operation, client, ports);
      if (!row) return output(owner, null);
      // Recheck ownership after the awaited locked/final snapshot owner read.
      if (!sameOriginal(row, owner, actor.userId) || !sameOriginal(row, discovered, actor.userId)) return output(owner, { state: 'blocked', identity: null, canCancel: false });
      return output(owner, { state: 'cancelled', identity: identity(row) });
    }
    const command = decode(row); // Corruption is never converted to blocked metadata.
    try {
      const prepared = await prepareFacialRevisionWith(operation, client, ports, command);
      const { owner, replayId, previousVersion } = await inspectFacialPreparation(prepared, operation, client, ports);
      if (!sameOriginal(row, owner, actor.userId)) facialFail(409, 'facial_submission_context_changed');
      if (row.previous_version !== previousVersion
        || row.state === 'committed' && (replayId === null || row.revision_id !== replayId)) facialFail(500, 'invalid_facial_submission');
      await assertFacialOperation(operation, client, ports, true);
      return output(owner, { state: row.state, identity: identity(row), expected: { actorId: actor.userId, scope: outputScope(owner), command, previousVersion: row.previous_version! } });
    } catch (error) {
      if (!(error instanceof FacialFault) || ![400, 403, 404, 409].includes(error.status) || !recoverable.has(error.code)) throw error;
      const owner = await readFacialOwnerWith(operation, client, ports);
      const canCancel = sameOriginal(row, owner, actor.userId) && row.state === 'pending' && await facialEligibility(operation, client, ports);
      await assertFacialOperation(operation, client, ports);
      return output(owner, { state: 'blocked', identity: canCancel ? identity(row) : null, canCancel });
    }
  } finally { closeFacialOperation(operation); }
}
/** Canonical NOWAIT extraction delta: provenance-only parent lock before owner.
 * No visibility, MIME, byte, image permission or decoding requirement is added.
 * Legacy WAIT retains its original transition/deferred-trigger lock order. */
async function transitionProvenance(operation: FacialOperation, client: FacialQuery, ports: FacialWritePorts, row: SubmissionRow | null) {
  if (ports.locking !== 'nowait' || !row || row.document_id === null) return;
  const { rows: [doc] } = await facialQuery<{ id: number; patient_id: number; ortho_case_id: number | null }>(operation, client, ports,
    'SELECT id,patient_id,ortho_case_id FROM patient_documents WHERE id=$1 FOR SHARE NOWAIT', [row.document_id]);
  // 0116 permits case reassignment only after both cancellation and acknowledgment.
  // The exact document FK and same-patient provenance remain mandatory.
  const releasedCase = row.state === 'cancelled' && row.acknowledged_at !== null;
  if (!doc || doc.id !== row.document_id || doc.patient_id !== row.patient_id || !releasedCase && doc.ortho_case_id !== row.ortho_case_id) facialFail(409, 'facial_submission_context_changed');
}
export async function transitionFacialSubmissionWith(client: FacialQuery, input: FacialSubmissionTransition, ports: FacialWritePorts) {
  requestScope(input, 'invalid_facial_submission_transition');
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const expected = { clinicalCaseId: input.clinicalCaseId, actorId: input.actorId }, commandId = input.commandId, hash = input.requestFingerprint, action = input.action;
  if (!commandIdValid(commandId) || !facialHash(hash) || !['acknowledge', 'cancel'].includes(action)) facialFail(400, 'invalid_facial_submission_transition');
  const pinnedScope = facialScope(input), configuration = pinFacialConfiguration(client, ports);
  await fence(client, ports, configuration);
  configuration();
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const operation = await openFacialOperation(client, pinnedScope, ports);
  try {
    const actor = await bind(operation, client, ports, expected);
    let row = await find(operation, client, ports, commandId);
    if (row && row.request_fingerprint !== hash) facialFail(409, 'request_key_conflict');
    if (!row && await outstanding(operation, client, ports)) facialFail(409, 'facial_submission_unacknowledged');
    await transitionProvenance(operation, client, ports, row);
    const owner = await readFacialOwnerWith(operation, client, ports);
    if (owner.clinicalCaseId !== expected.clinicalCaseId || row && !currentContext(row, owner, actor.userId)) facialFail(409, 'facial_submission_context_changed');
    if (!row) {
      if (action !== 'cancel') facialFail(404, 'facial_submission_not_found');
      const legacy = (await facialQuery<{ request_fingerprint: string }>(operation, client, ports,
        'SELECT request_fingerprint FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3', [owner.orthoCaseId, actor.userId, commandId])).rows[0];
      if (legacy) facialFail(409, legacy.request_fingerprint === hash ? 'facial_submission_already_committed' : 'request_key_conflict');
      row = requireRow((await facialQuery<SubmissionRow>(operation, client, ports,
        `INSERT INTO ortho_facial_submissions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,actor_user_id,command_id,request_fingerprint,command,previous_version,state,settled_at)
         VALUES($1,$1,$2,$3,$4,$5,$6,NULL,NULL,'cancelled',clock_timestamp()) RETURNING *`, [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, actor.userId, commandId, hash])).rows[0]);
      insertedContext(row, owner, actor.userId, commandId, hash);
      if (row.state !== 'cancelled' || row.document_id !== null || row.acknowledged_at !== null) facialFail(500, 'invalid_facial_submission');
      await audit(operation, client, ports, row, 'cancelled_before_arrival', false);
    } else if (action === 'cancel' && row.state === 'pending') {
      const cancelled = requireRow((await facialQuery<SubmissionRow>(operation, client, ports,
        "UPDATE ortho_facial_submissions SET state='cancelled',settled_at=clock_timestamp() WHERE id=$1 RETURNING *", [row.id])).rows[0]);
      stableIdentity(row, cancelled);
      if (cancelled.state !== 'cancelled' || cancelled.acknowledged_at !== null || canonicalJourneyJSON(cancelled.command) !== canonicalJourneyJSON(row.command)) facialFail(500, 'invalid_facial_submission');
      row = cancelled; await audit(operation, client, ports, row, 'cancelled', false);
    } else if (action === 'cancel' && row.state === 'committed') facialFail(409, 'facial_submission_already_committed');
    if (action === 'acknowledge') {
      if (row.state === 'pending') facialFail(409, 'facial_submission_pending');
      if (row.acknowledged_at === null) {
        const ack = requireRow((await facialQuery<SubmissionRow>(operation, client, ports,
          'UPDATE ortho_facial_submissions SET acknowledged_at=clock_timestamp(),command=NULL WHERE id=$1 RETURNING *', [row.id])).rows[0]);
        stableIdentity(row, ack);
        if (ack.state !== row.state || ack.revision_id !== row.revision_id || ack.acknowledged_at === null || ack.command !== null) facialFail(500, 'invalid_facial_submission');
        row = ack; await audit(operation, client, ports, row, 'acknowledged', false);
      }
    }
    await assertFacialOperation(operation, client, ports);
    return { ok: true as const, scope: outputScope(owner), actorId: actor.userId, identity: identity(row), state: row.state, acknowledged: row.acknowledged_at !== null };
  } finally { closeFacialOperation(operation); }
}
