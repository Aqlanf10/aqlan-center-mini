/** INACTIVE. Trusted adapters own admission, transaction/snapshot lifetime and fences.
 * These ports do not grant authority. Every callback must re-prove its private
 * operation, exact client/transaction, live actor, action and patient scope.
 * No production adapter, schema registration or audit vocabulary is installed. */
import type { FacialContent } from './ortho-facial-analysis';

export interface FacialQuery {
  query<Row extends object = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
}
export type FacialScope = Readonly<{ patientId: number; orthoCaseId: number }>;
export type FacialActor = Readonly<{ userId: number; name: string; role: string }>;
export interface FacialOwner extends FacialScope {
  readonly clinicalCaseId: number;
  readonly status: 'assessment' | 'active' | 'retention' | 'completed' | 'discontinued';
  readonly planId: number | null;
  readonly recordingContext: 'current' | 'retrospective';
}
export interface FacialDocumentSource {
  readonly id: number; readonly patient_id: number; readonly ortho_case_id: number;
  readonly photo_stage: string | null; readonly photo_view: string | null;
  readonly removed_at: Date | null; readonly sha256: string; readonly storage_key: string;
  readonly mime_type: string; readonly size_bytes: string | number;
  readonly title: string; readonly taken_on: string | null;
}
export type FacialBasis = FacialContent['image'];
/** Must use bounded same-handle bytes, actual digest and full oriented decoding.
 * A snapshot adapter must verify an exact predecoded source witness in its final
 * current snapshot; it must not acquire locks or export a PNG side channel. */
export interface FacialImagePort { verify(source: Readonly<FacialDocumentSource>): Promise<FacialBasis> }
/** Only a legacy locked read may render here. Later canonical two-phase PNG
 * publication needs its own reviewed facade; a JSON snapshot cannot accept this. */
export interface FacialPNGPort {
  render(source: Readonly<FacialDocumentSource>): Promise<{ basis: FacialBasis; png: Buffer }>;
}
export type FacialAuditEvent = Readonly<{
  actor: FacialActor; entityId: number;
} & ({
  action: 'ortho.facial_revision'; entity: 'ortho_facial_revisions';
  details: { patientId: number; orthoCaseId: number; documentId: number; version: number; review: 'draft' | 'reviewed'; requestFingerprint: string };
} | {
  action: 'ortho.facial_submission'; entity: 'ortho_facial_submissions';
  details: { event: 'reserved' | 'committed' | 'cancelled_before_arrival' | 'cancelled' | 'acknowledged'; orthoCaseId: number; requestFingerprint: string; state: 'pending' | 'committed' | 'cancelled' };
})>;
export interface FacialAuditPort { append(client: FacialQuery, event: FacialAuditEvent): Promise<void> }
export interface FacialClockPort { today(): string }
interface FacialImageAuthority {
  // Must include a fresh clinical/scope assertion as well as image permission.
  assertImages(client: FacialQuery, scope: FacialScope, actor: FacialActor): Promise<FacialActor>;
}
export interface FacialWriteAuthority extends FacialImageAuthority {
  authorizeWrite(client: FacialQuery, scope: FacialScope): Promise<FacialActor>;
  assertWrite(client: FacialQuery, scope: FacialScope, actor: FacialActor): Promise<FacialActor>;
}
export interface FacialReadAuthority extends FacialImageAuthority {
  authorizeRead(client: FacialQuery, scope: FacialScope): Promise<FacialActor>;
  assertRead(client: FacialQuery, scope: FacialScope, actor: FacialActor): Promise<FacialActor>;
  // Current display eligibility only. A deliberate action denial may be false;
  // expired/stale/broken identity must throw, never become false.
  readWriteEligibility(client: FacialQuery, scope: FacialScope, actor: FacialActor): Promise<boolean>;
}
interface FacialPorts { readonly images: FacialImagePort; readonly clock: FacialClockPort }
export interface FacialWritePorts extends FacialPorts {
  readonly mode: 'write'; readonly locking: 'wait' | 'nowait';
  readonly authority: FacialWriteAuthority; readonly audit: FacialAuditPort;
}
export interface FacialLegacyReadPorts extends FacialPorts {
  readonly mode: 'legacy-read'; readonly authority: FacialReadAuthority;
}
export interface FacialSnapshotReadPorts extends FacialPorts {
  readonly mode: 'snapshot-read'; readonly authority: FacialReadAuthority;
}
export type FacialReadPorts = FacialLegacyReadPorts | FacialSnapshotReadPorts;
export type FacialCorePorts = FacialWritePorts | FacialReadPorts;
export type FacialFaultCode =
  | 'invalid_scope' | 'invalid_facial_analysis' | 'invalid_image_date' | 'invalid_history_cursor'
  | 'ortho_case_not_found' | 'invalid_case_state' | 'ambiguous_bridge' | 'bridge_missing' | 'scope_mismatch'
  | 'facial_document_unavailable' | 'facial_history_invalid' | 'facial_history_too_large'
  | 'facial_history_anchor_unavailable' | 'facial_history_anchor_changed' | 'facial_head_changed'
  | 'facial_image_changed' | 'facial_image_unsupported' | 'facial_image_integrity' | 'facial_image_decode'
  | 'image_access_denied' | 'request_key_conflict' | 'invalid_facial_submission'
  | 'invalid_facial_submission_scope' | 'invalid_facial_submission_transition'
  | 'facial_submission_actor_changed' | 'facial_submission_context_changed' | 'facial_submission_cancelled'
  | 'facial_submission_unacknowledged' | 'facial_submission_result_mismatch' | 'facial_submission_not_found'
  | 'facial_submission_already_committed' | 'facial_submission_pending'
  | 'facial_authority_changed' | 'facial_core_context_changed' | 'facial_core_port_invalid';
export class FacialFault extends Error {
  constructor(readonly status: number, readonly code: FacialFaultCode, message = 'تعذّر التحقق من سجل الحالة؛ أعد القراءة وراجع الصلاحيات والمراجع.') { super(message); }
}
export function facialFail(status: number, code: FacialFaultCode): never { throw new FacialFault(status, code); }
export const facialId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
export const facialHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function facialScope(input: FacialScope): FacialScope {
  if (!facialId(input.patientId) || !facialId(input.orthoCaseId)) facialFail(400, 'invalid_scope');
  return Object.freeze({ patientId: input.patientId, orthoCaseId: input.orthoCaseId });
}
function actorCopy(actor: FacialActor): FacialActor {
  if (!actor || !facialId(actor.userId) || typeof actor.name !== 'string' || !actor.name.trim() || typeof actor.role !== 'string' || !actor.role.trim()) facialFail(500, 'facial_core_port_invalid');
  return Object.freeze({ userId: actor.userId, name: actor.name, role: actor.role });
}
function sameActor(actual: FacialActor, expected: FacialActor) {
  const current = actorCopy(actual);
  if (current.userId !== expected.userId || current.name !== expected.name || current.role !== expected.role) facialFail(401, 'facial_authority_changed');
}
/** Pin configuration identity before any fence/admission await. This witness
 * grants nothing: live action/scope/identity are still asserted by the callbacks.
 * Do not freeze adapter objects, and do not copy a current permission result. */
export function pinFacialConfiguration(client: FacialQuery, ports: FacialCorePorts): () => void {
  const query = client.query, mode = ports.mode, authority = ports.authority, images = ports.images, clock = ports.clock;
  const verify = images.verify, today = clock.today, imageCurrent = authority.assertImages;
  const write = ports.mode === 'write' ? { authorize: ports.authority.authorizeWrite, current: ports.authority.assertWrite,
    locking: ports.locking, audit: ports.audit, append: ports.audit.append } : null;
  const read = ports.mode !== 'write' ? { authorize: ports.authority.authorizeRead, current: ports.authority.assertRead,
    eligibility: ports.authority.readWriteEligibility } : null;
  return () => {
    if (client.query !== query || ports.mode !== mode || ports.authority !== authority || ports.images !== images || ports.clock !== clock
      || images.verify !== verify || clock.today !== today || authority.assertImages !== imageCurrent) facialFail(500, 'facial_core_context_changed');
    if (write) {
      if (ports.mode !== 'write' || ports.authority.authorizeWrite !== write.authorize || ports.authority.assertWrite !== write.current
        || ports.locking !== write.locking || ports.audit !== write.audit || ports.audit.append !== write.append) facialFail(500, 'facial_core_context_changed');
    } else if (!read || ports.mode === 'write' || ports.authority.authorizeRead !== read.authorize || ports.authority.assertRead !== read.current
      || ports.authority.readWriteEligibility !== read.eligibility) facialFail(500, 'facial_core_context_changed');
  };
}
/** Opaque, short-lived internal handle. Neither attribution nor this handle is
 * authority: every use calls back into the adapter's private live proof. */
declare const operationBrand: unique symbol;
export type FacialOperation = { readonly [operationBrand]: true };
type Current = (client: FacialQuery, scope: FacialScope, actor: FacialActor) => Promise<FacialActor>;
interface Operation {
  client: FacialQuery; ports: FacialCorePorts; scope: FacialScope; actor: FacialActor; configuration: () => void;
  authority: FacialCorePorts['authority']; images: FacialImagePort; clock: FacialClockPort; current: Current; imageCurrent: Current;
  verify: FacialImagePort['verify']; today: FacialClockPort['today']; query: FacialQuery['query'];
  mode: FacialCorePorts['mode']; locking: 'wait' | 'nowait' | null;
  audit?: FacialAuditPort; append?: FacialAuditPort['append']; eligibility?: FacialReadAuthority['readWriteEligibility'];
}
const operations = new WeakMap<FacialOperation, Operation>();
function state(handle: FacialOperation, client: FacialQuery, ports: FacialCorePorts): Operation {
  const s = operations.get(handle);
  s?.configuration();
  if (!s || s.client !== client || s.ports !== ports || s.query !== client.query || s.authority !== ports.authority || s.mode !== ports.mode
    || s.images !== ports.images || s.clock !== ports.clock || s.verify !== ports.images.verify || s.today !== ports.clock.today || s.imageCurrent !== ports.authority.assertImages
    || (ports.mode === 'write' ? s.current !== ports.authority.assertWrite || s.audit !== ports.audit || s.append !== ports.audit.append || s.locking !== ports.locking
      : s.current !== ports.authority.assertRead || s.eligibility !== ports.authority.readWriteEligibility)) facialFail(500, 'facial_core_context_changed');
  return s;
}
export async function openFacialOperation(client: FacialQuery, input: FacialScope, ports: FacialCorePorts): Promise<FacialOperation> {
  const scope = facialScope(input), configuration = pinFacialConfiguration(client, ports);
  if (!['write', 'legacy-read', 'snapshot-read'].includes(ports.mode) || ports.mode === 'write' && !['wait', 'nowait'].includes(ports.locking)) facialFail(500, 'facial_core_port_invalid');
  const handle = Object.freeze({}) as FacialOperation;
  const authority = ports.authority;
  const current = ports.mode === 'write' ? ports.authority.assertWrite : ports.authority.assertRead;
  const authorize = ports.mode === 'write' ? ports.authority.authorizeWrite : ports.authority.authorizeRead;
  // Capture before awaiting admission; mutable input/ports cannot change a scope.
  const saved = { client, ports, scope, configuration, authority, images: ports.images, clock: ports.clock, current, imageCurrent: authority.assertImages, verify: ports.images.verify, today: ports.clock.today, query: client.query,
    mode: ports.mode, locking: ports.mode === 'write' ? ports.locking : null,
    ...(ports.mode === 'write' ? { audit: ports.audit, append: ports.audit.append } : { eligibility: ports.authority.readWriteEligibility }) };
  const actor = actorCopy(await authorize.call(authority, client, scope));
  operations.set(handle, { ...saved, actor });
  try { await assertFacialOperation(handle, client, ports); return handle; }
  catch (error) { operations.delete(handle); throw error; }
}
export function closeFacialOperation(handle: FacialOperation) { operations.delete(handle); }
export function facialOperationData(handle: FacialOperation, client: FacialQuery, ports: FacialCorePorts) {
  const s = state(handle, client, ports); return { actor: s.actor, scope: s.scope };
}
export async function assertFacialOperation(handle: FacialOperation, client: FacialQuery, ports: FacialCorePorts, images = false) {
  const s = state(handle, client, ports);
  sameActor(await s.current.call(s.authority, client, s.scope, s.actor), s.actor); state(handle, client, ports);
  if (images) {
    sameActor(await s.imageCurrent.call(s.authority, client, s.scope, s.actor), s.actor); state(handle, client, ports);
  }
}
export async function facialQuery<Row extends object = Record<string, unknown>>(handle: FacialOperation, client: FacialQuery, ports: FacialCorePorts, sql: string, values?: unknown[], images = false,
  beforeSnapshot?: (rows: readonly Row[]) => void) {
  await assertFacialOperation(handle, client, ports, images);
  const result = await client.query<Row>(sql, values);
  if (!Array.isArray(result.rows)) facialFail(500, 'facial_core_port_invalid');
  // Raw history budgets must run before copying/decoding any result. The guard
  // is synchronous and internal; it cannot introduce a new authority await.
  beforeSnapshot?.(result.rows);
  let rows: Row[];
  try { rows = structuredClone(result.rows); }
  catch { facialFail(500, 'facial_core_port_invalid'); }
  // Never retain the adapter's mutable rows across a current-proof await. This
  // preserves nested saved evidence and primitive identity/version projections.
  await assertFacialOperation(handle, client, ports, images);
  return { rows };
}
export function facialLock(ports: FacialCorePorts, write: boolean, discovery = false): string {
  if (discovery || ports.mode === 'snapshot-read') return '';
  return `${write ? 'FOR UPDATE' : 'FOR SHARE'}${ports.mode === 'write' && ports.locking === 'nowait' ? ' NOWAIT' : ''}`;
}
export async function facialEligibility(handle: FacialOperation, client: FacialQuery, ports: FacialReadPorts) {
  await assertFacialOperation(handle, client, ports);
  const s = state(handle, client, ports);
  const result = await ports.authority.readWriteEligibility(client, s.scope, s.actor);
  await assertFacialOperation(handle, client, ports);
  if (typeof result !== 'boolean') facialFail(500, 'facial_core_port_invalid');
  return result;
}
export function validateFacialBasis(value: FacialBasis, source: FacialDocumentSource): FacialBasis {
  if (!value || Object.keys(value).sort().join(',') !== 'exifOrientation,height,sha256,width' || !facialHash(value.sha256) || value.sha256 !== source.sha256
    || !facialId(value.width) || !facialId(value.height) || value.width > 16384 || value.height > 16384 || value.width * value.height > 16000000
    || !facialId(value.exifOrientation) || value.exifOrientation > 8) facialFail(409, 'facial_image_integrity');
  return Object.freeze({ ...value });
}
export async function verifyFacialImage(handle: FacialOperation, client: FacialQuery, ports: FacialCorePorts, source: FacialDocumentSource) {
  await assertFacialOperation(handle, client, ports, true);
  const basis = await ports.images.verify(source);
  await assertFacialOperation(handle, client, ports, true);
  return validateFacialBasis(basis, source);
}
export async function appendFacialAudit(handle: FacialOperation, client: FacialQuery, ports: FacialWritePorts, event: FacialAuditEvent, images: boolean) {
  await assertFacialOperation(handle, client, ports, images);
  const s = state(handle, client, ports); sameActor(event.actor, s.actor);
  await ports.audit.append(client, event);
  await assertFacialOperation(handle, client, ports, images);
}
