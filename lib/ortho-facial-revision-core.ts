/** Inactive caller-owned immutable revision kernel. No connection/transaction owner. */
import { journeyContentHash } from './ortho-case-journey-hash';
import { canonicalJourneyJSON } from './ortho-case-journey-json';
import { isDocumentAcquisitionDate } from './document-acquisition-date';
import { computeFacialResults, readFacialCommand, type FacialCommand, type FacialResults } from './ortho-facial-analysis';
import { readFacialRevision, type FacialRevision } from './ortho-facial-records';
import {
  facialFail, facialId, facialHash, facialScope, facialLock, facialQuery, facialOperationData, assertFacialOperation,
  openFacialOperation, closeFacialOperation, verifyFacialImage, appendFacialAudit, pinFacialConfiguration,
  type FacialQuery, type FacialScope, type FacialOwner, type FacialDocumentSource, type FacialCorePorts,
  type FacialWritePorts, type FacialOperation,
} from './ortho-facial-core-contract';

export function parseFacialCoreCommand(raw: unknown): FacialCommand {
  try { return readFacialCommand(raw); } catch { facialFail(400, 'invalid_facial_analysis'); }
}
/** Source before case/bridge locks. A snapshot kernel emits no row locks. */
export async function readFacialSourceWith(operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts, documentId: number): Promise<FacialDocumentSource> {
  const { scope } = facialOperationData(operation, client, ports);
  if (!facialId(documentId)) facialFail(400, 'invalid_scope');
  await assertFacialOperation(operation, client, ports, true);
  const { rows: [doc] } = await facialQuery<FacialDocumentSource>(operation, client, ports,
    `SELECT photo_stage,photo_view,id,patient_id,ortho_case_id,sha256,storage_key,mime_type,size_bytes,removed_at,title,to_char(taken_on,'YYYY-MM-DD') AS taken_on FROM patient_documents WHERE id=$1 ${facialLock(ports, false)}`, [documentId]);
  if (!doc || doc.id !== documentId || doc.patient_id !== scope.patientId || doc.ortho_case_id !== scope.orthoCaseId || doc.removed_at !== null || doc.photo_stage === 'archived' || doc.photo_view !== 'extraoral_frontal') facialFail(404, 'facial_document_unavailable');
  if (!facialHash(doc.sha256) || typeof doc.storage_key !== 'string' || !doc.storage_key || typeof doc.mime_type !== 'string' || typeof doc.title !== 'string' || !(doc.taken_on === null || isDocumentAcquisitionDate(doc.taken_on))) facialFail(409, 'facial_image_integrity');
  return Object.freeze({ ...doc });
}
/** Discovery is not mutation authority. The source must precede locked owner reads. */
export async function readFacialOwnerWith(operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts, options: { discovery?: boolean; write?: boolean } = {}): Promise<FacialOwner> {
  const { scope } = facialOperationData(operation, client, ports);
  const lock = facialLock(ports, options.write ?? ports.mode === 'write', options.discovery);
  const { rows: cases } = await facialQuery<{ id: number; patient_id: number; status: string; plan_id: number | null }>(operation, client, ports,
    `SELECT id,patient_id,status,plan_id FROM ortho_cases WHERE id=$1 ${lock}`, [scope.orthoCaseId]);
  const ortho = cases[0];
  if (cases.length !== 1 || !ortho || ortho.id !== scope.orthoCaseId || ortho.patient_id !== scope.patientId) facialFail(404, 'ortho_case_not_found');
  // Pinned facial source includes assessment. Do not widen the destination's
  // unrelated documentation helper, whose WORK slice has a narrower contract.
  if (!['assessment', 'active', 'retention', 'completed', 'discontinued'].includes(ortho.status)) facialFail(409, 'invalid_case_state');
  if (!(ortho.plan_id === null || facialId(ortho.plan_id))) facialFail(409, 'scope_mismatch');
  const { rows: bridges } = await facialQuery<{ id: number; patient_id: number; ortho_case_id: number; specialty: string }>(operation, client, ports,
    `SELECT id,patient_id,ortho_case_id,specialty FROM clinical_cases WHERE ortho_case_id=$1 ${lock}`, [ortho.id]);
  if (bridges.length !== 1) facialFail(409, bridges.length ? 'ambiguous_bridge' : 'bridge_missing');
  const bridge = bridges[0];
  if (!facialId(bridge.id) || bridge.patient_id !== scope.patientId || bridge.ortho_case_id !== ortho.id || bridge.specialty !== 'orthodontics') facialFail(409, 'scope_mismatch');
  return Object.freeze({ ...scope, clinicalCaseId: bridge.id, status: ortho.status as FacialOwner['status'], planId: ortho.plan_id,
    recordingContext: ortho.status === 'completed' || ortho.status === 'discontinued' ? 'retrospective' : 'current' });
}
export function readStoredFacialRevision(row: Record<string, unknown>, owner: FacialOwner): FacialRevision {
  try {
    if (!(row.created_at instanceof Date) || !Number.isFinite(row.created_at.getTime())) facialFail(500, 'facial_history_invalid');
    const revision = readFacialRevision({ id: row.id, patientId: row.patient_id, orthoCaseId: row.ortho_case_id, clinicalCaseId: row.clinical_case_id, documentId: row.document_id,
      recordedPatientId: row.recorded_patient_id, version: row.version, actorId: row.actor_user_id, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
      requestFingerprint: row.request_fingerprint, contentHash: row.content_sha256, command: row.command, results: row.results }, owner);
    if (revision.clinicalCaseId !== owner.clinicalCaseId || journeyContentHash(revision.command) !== revision.requestFingerprint
      || journeyContentHash({ content: revision.command.content, results: revision.results }) !== revision.contentHash
      || row.command_id !== revision.command.clientRequestId || row.previous_revision_id !== revision.command.expectedHeadId) facialFail(500, 'facial_history_invalid');
    return revision;
  } catch { facialFail(500, 'facial_history_invalid'); }
}
interface Prepared {
  operation: FacialOperation; client: FacialQuery; ports: FacialCorePorts;
  doc: FacialDocumentSource; owner: FacialOwner; command: FacialCommand; fingerprint: string;
  replay: FacialRevision | null; head: { id: number; version: number } | null; results: FacialResults;
}
declare const preparedBrand: unique symbol;
export type PreparedFacialRevision = { readonly [preparedBrand]: true };
const preparations = new WeakMap<PreparedFacialRevision, Prepared>();
function preparedState(handle: PreparedFacialRevision, operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts) {
  const p = preparations.get(handle);
  if (!p || p.operation !== operation || p.client !== client || p.ports !== ports) facialFail(500, 'facial_core_context_changed');
  facialOperationData(operation, client, ports);
  return p;
}
/** Internal opaque preparation, valid only inside this operation. Returned data
 * cannot be used to bypass a later current assertion or another transaction. */
export async function prepareFacialRevisionWith(operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts, raw: unknown): Promise<PreparedFacialRevision> {
  const command = parseFacialCoreCommand(raw);
  const { actor } = facialOperationData(operation, client, ports);
  await assertFacialOperation(operation, client, ports, true);
  const doc = await readFacialSourceWith(operation, client, ports, command.documentId);
  const owner = await readFacialOwnerWith(operation, client, ports);
  const fingerprint = journeyContentHash(command);
  const replayRow = (await facialQuery(operation, client, ports, 'SELECT * FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND actor_user_id=$2 AND command_id=$3', [owner.orthoCaseId, actor.userId, command.clientRequestId])).rows[0];
  const replay = replayRow ? readStoredFacialRevision(replayRow, owner) : null;
  if (replay && (replay.actorId !== actor.userId || replay.command.clientRequestId !== command.clientRequestId || replay.requestFingerprint !== fingerprint)) facialFail(409, 'request_key_conflict');
  const image = await verifyFacialImage(operation, client, ports, doc);
  if (canonicalJourneyJSON(image) !== canonicalJourneyJSON(command.content.image)) facialFail(409, 'facial_image_changed');
  const head = (await facialQuery<{ id: number; version: number }>(operation, client, ports,
    'SELECT id,version FROM ortho_facial_revisions WHERE ortho_case_id=$1 AND document_id=$2 ORDER BY version DESC LIMIT 1', [owner.orthoCaseId, doc.id])).rows[0] ?? null;
  if (head && (!facialId(head.id) || !facialId(head.version))) facialFail(500, 'facial_history_invalid');
  const results = computeFacialResults(command.content);
  if (!replay) {
    const date = command.content.occurrence.occurredOn, today = ports.clock.today();
    if (!isDocumentAcquisitionDate(today)) facialFail(500, 'facial_core_port_invalid');
    if (date !== null && (date < '1900-01-01' || date > today)) facialFail(400, 'invalid_image_date');
    if ((head?.id ?? null) !== command.expectedHeadId) facialFail(409, 'facial_head_changed');
    if (command.content.review.state === 'reviewed' && results.measures.some(measure => measure.state === 'invalid_geometry')) facialFail(400, 'invalid_facial_analysis');
  }
  await assertFacialOperation(operation, client, ports, true);
  const handle = Object.freeze({}) as PreparedFacialRevision;
  preparations.set(handle, { operation, client, ports, doc, owner, command, fingerprint, replay, head, results });
  return handle;
}
/** Returns inert identity/version witnesses only, never retained command or authority. */
export async function inspectFacialPreparation(handle: PreparedFacialRevision, operation: FacialOperation, client: FacialQuery, ports: FacialCorePorts) {
  const p = preparedState(handle, operation, client, ports);
  await assertFacialOperation(operation, client, ports, true);
  preparedState(handle, operation, client, ports);
  return Object.freeze({ owner: p.owner, replayId: p.replay?.id ?? null, previousVersion: p.replay ? p.replay.version - 1 : p.head?.version ?? 0 });
}
export async function appendPreparedFacialRevisionWith(handle: PreparedFacialRevision, operation: FacialOperation, client: FacialQuery, ports: FacialWritePorts) {
  const p = preparedState(handle, operation, client, ports);
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  preparations.delete(handle); // One use, including failed append; never reuse after uncertain I/O.
  const { actor } = facialOperationData(operation, client, ports);
  await assertFacialOperation(operation, client, ports, true);
  if (p.replay) return { ok: true as const, replayed: true, revision: p.replay };
  const { owner, doc, command, fingerprint, head, results } = p;
  const contentHash = journeyContentHash({ content: command.content, results });
  const saved = (await facialQuery(operation, client, ports,
    `INSERT INTO ortho_facial_revisions(patient_id,recorded_patient_id,ortho_case_id,clinical_case_id,document_id,version,previous_revision_id,actor_user_id,created_by,command_id,request_fingerprint,content_sha256,command,results)
     VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb) RETURNING *`,
    [owner.patientId, owner.orthoCaseId, owner.clinicalCaseId, doc.id, (head?.version ?? 0) + 1, head?.id ?? null, actor.userId, actor.name, command.clientRequestId, fingerprint, contentHash, JSON.stringify(command), JSON.stringify(results)], true)).rows[0];
  const revision = readStoredFacialRevision(saved, owner);
  if (revision.actorId !== actor.userId || revision.createdBy !== actor.name || revision.documentId !== doc.id || revision.version !== (head?.version ?? 0) + 1
    || revision.recordedPatientId !== owner.patientId || revision.requestFingerprint !== fingerprint || revision.contentHash !== contentHash) facialFail(500, 'facial_history_invalid');
  await appendFacialAudit(operation, client, ports, { action: 'ortho.facial_revision', actor, entity: 'ortho_facial_revisions', entityId: revision.id,
    details: { patientId: owner.patientId, orthoCaseId: owner.orthoCaseId, documentId: doc.id, version: revision.version, review: command.content.review.state, requestFingerprint: fingerprint } }, true);
  await assertFacialOperation(operation, client, ports, true);
  return { ok: true as const, replayed: false, revision };
}
/** Caller must own rollback on any rejection, including audit/current-proof failure. */
export async function appendFacialRevisionWith(client: FacialQuery, scope: FacialScope, raw: unknown, ports: FacialWritePorts) {
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const command = parseFacialCoreCommand(raw), pinnedScope = facialScope(scope), configuration = pinFacialConfiguration(client, ports);
  // Caller establishes its private identity fence first; table fence precedes
  // authority admission's patient lock, matching the pinned reset order.
  await client.query('LOCK TABLE ortho_facial_revisions IN ROW EXCLUSIVE MODE');
  configuration();
  if (ports.mode !== 'write') facialFail(500, 'facial_core_context_changed');
  const operation = await openFacialOperation(client, pinnedScope, ports);
  try { return await appendPreparedFacialRevisionWith(await prepareFacialRevisionWith(operation, client, ports, command), operation, client, ports); }
  finally { closeFacialOperation(operation); }
}
