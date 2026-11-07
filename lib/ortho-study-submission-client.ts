import { canonicalJourneyJSON } from './ortho-case-journey-json';
import type { JourneyScope } from './ortho-case-journey-records';
import type { StudyOwner } from './ortho-case-study-owner';
import { studyBrowserHash, type StudySaveExpectation } from './ortho-case-study-editor-response';
import { readStudySubmissionIdentity, verifyStudySubmissionRecovery, type StudySubmissionIdentity, type StudySubmissionRecovery } from './ortho-study-submission-contract';

export interface StudySubmissionRead {
  receipt: StudySubmissionRecovery['recovery'];
  conflict: boolean;
}
type CommandIdentity = Pick<StudySubmissionIdentity, 'commandId' | 'requestFingerprint'> & { id?: number };
type Operation = NonNullable<ReturnType<StudyOwner['begin']>>;
interface ReadContext { owner: StudyOwner; scope: JourneyScope; current(): boolean }
const endpoint = (scope: JourneyScope) => `/api/ortho/${scope.orthoCaseId}/case-study/recovery`;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const noStore = (response: Response) => response.headers.get('cache-control')?.split(',').some(value => value.trim().toLowerCase() === 'no-store');
export async function readStudySubmissionJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).length > 8 * 1024 * 1024) throw Error('study_response_limit');
  return JSON.parse(text);
}
function requireCurrent(context: ReadContext) {
  if (!context.owner.active() || !context.owner.matches(context.scope) || !context.current()) throw Error('study_submission_stale');
}
function checkResponse(response: Response, context: ReadContext) {
  requireCurrent(context);
  if (response.status === 401 || response.status === 403) { context.owner.denied(); throw Error('study_submission_denied'); }
  if (response.status !== 200 || !noStore(response)) throw Error('study_submission_unconfirmed');
}
export async function fetchStudySubmissionRecovery(context: ReadContext, signal?: AbortSignal): Promise<StudySubmissionRead> {
  requireCurrent(context);
  const response = await fetch(`${endpoint(context.scope)}?${new URLSearchParams({ patientId: String(context.scope.patientId) })}`, {
    credentials: 'same-origin', cache: 'no-store', signal,
  });
  checkResponse(response, context);
  const verified = await verifyStudySubmissionRecovery(await readStudySubmissionJson(response), context.scope, context.owner.actorId);
  requireCurrent(context);
  const receipt = verified.recovery;
  // Metadata-only absence/cancellation does not reauthorize retained command
  // content, including when another tab already cancelled or acknowledged it.
  if ((!receipt || receipt.state === 'cancelled') && context.owner.retryExpectation) context.owner.quarantineDraft();
  // A missing server receipt does not prove that a delayed POST will not arrive.
  if (!receipt) return { receipt, conflict: false };
  // Persist the restriction outside this temporary view before any render can
  // expose retained local bytes, including after a later cancellation receipt.
  if (receipt.state === 'blocked') context.owner.quarantineDraft();
  if (receipt.state === 'pending' || receipt.state === 'committed') {
    const conflict = !context.owner.restore(receipt.expected);
    if (conflict) context.owner.quarantineDraft();
    return { receipt, conflict };
  }
  const expected = context.owner.retryExpectation;
  const fingerprint = expected ? await studyBrowserHash(expected.command) : null;
  requireCurrent(context);
  const conflict = !!expected && (!receipt.identity || receipt.identity.commandId !== expected.command.clientRequestId || receipt.identity.requestFingerprint !== fingerprint);
  return { receipt, conflict };
}
export function canRetryStudySubmission(recovery: StudySubmissionRead | null) {
  return !!recovery && !recovery.conflict && (!recovery.receipt || recovery.receipt.state === 'pending' || recovery.receipt.state === 'committed');
}
export function canCancelStudySubmission(owner: StudyOwner, recovery: StudySubmissionRead | null) {
  if (!recovery || !owner.canResolveSubmission() || owner.busy || recovery.conflict && !!owner.retryExpectation) return false;
  const receipt = recovery.receipt;
  if (!receipt) return !!owner.retryExpectation;
  return receipt.state === 'pending' || receipt.state === 'cancelled' || receipt.state === 'blocked' && receipt.canCancel;
}

/** Strict metadata-only terminal receipt; never accepts a differently bound reply. */
export function verifyStudySubmissionTransition(raw: unknown, scope: JourneyScope, actorId: number, expected: CommandIdentity,
  state: 'cancelled' | 'committed', acknowledged: boolean | 'either'): StudySubmissionIdentity {
  if (!record(raw) || !exactKeys(raw, ['ok', 'scope', 'actorId', 'identity', 'state', 'acknowledged']) || raw.ok !== true
    || raw.actorId !== actorId || raw.state !== state || typeof raw.acknowledged !== 'boolean' || acknowledged !== 'either' && raw.acknowledged !== acknowledged
    || !record(raw.scope) || !exactKeys(raw.scope, ['patientId', 'orthoCaseId', 'clinicalCaseId'])
    || raw.scope.patientId !== scope.patientId || raw.scope.orthoCaseId !== scope.orthoCaseId || raw.scope.clinicalCaseId !== scope.clinicalCaseId) throw Error('invalid_study_submission_transition');
  const identity = readStudySubmissionIdentity(raw.identity);
  if (identity.commandId !== expected.commandId || identity.requestFingerprint !== expected.requestFingerprint || expected.id !== undefined && identity.id !== expected.id) throw Error('study_submission_identity_changed');
  return identity;
}
async function postTransition(scope: JourneyScope, actorId: number, identity: CommandIdentity, action: 'cancel' | 'acknowledge') {
  return fetch(endpoint(scope), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ patientId: scope.patientId, clinicalCaseId: scope.clinicalCaseId, actorId, commandId: identity.commandId, requestFingerprint: identity.requestFingerprint, action }) });
}

/** Kept alive by the owner, rather than by a temporary mounted view. */
export async function submitAndAcknowledgeStudy(owner: StudyOwner, operation: Operation, expected: StudySaveExpectation, knownIdentity?: StudySubmissionIdentity): Promise<boolean> {
  try {
    const response = await fetch(`/api/ortho/${expected.scope.orthoCaseId}/case-study/editor`, { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' }, body: operation.body });
    if (!operation.checkHeaders(response)) return false;
    if (!response.ok) { operation.refuse(response.status); return false; }
    if (!noStore(response) || !await operation.confirmResponse(await readStudySubmissionJson(response), response.status)) throw Error('study_save_unconfirmed');
    const identity: CommandIdentity = { commandId: expected.command.clientRequestId, requestFingerprint: await studyBrowserHash(expected.command), ...(knownIdentity ? { id: knownIdentity.id } : {}) };
    if (!operation.current()) return false;
    if (knownIdentity && (knownIdentity.commandId !== identity.commandId || knownIdentity.requestFingerprint !== identity.requestFingerprint)) throw Error('study_submission_identity_changed');
    const acknowledgment = await postTransition(expected.scope, owner.actorId, identity, 'acknowledge');
    if (!operation.checkHeaders(acknowledgment)) return false;
    if (acknowledgment.status !== 200 || !noStore(acknowledgment)) throw Error('study_acknowledgment_unconfirmed');
    const raw = await readStudySubmissionJson(acknowledgment);
    if (!operation.current()) return false;
    verifyStudySubmissionTransition(raw, expected.scope, owner.actorId, identity, 'committed', true);
    if (!await operation.confirmAcknowledgment(raw)) throw Error('study_acknowledgment_unconfirmed');
    return true;
  } catch { operation.markUncertain(); return false; }
  finally { operation.finish(); }
}

/** Cancelling a pending command never deletes a saved clinical revision. */
export async function cancelAndAcknowledgeStudy(context: ReadContext, recovery: StudySubmissionRead, confirmCancel: () => boolean): Promise<boolean> {
  if (!canCancelStudySubmission(context.owner, recovery)) return false;
  requireCurrent(context);
  const receipt = recovery.receipt, expected = context.owner.retryExpectation;
  const expectedBytes = canonicalJourneyJSON(expected);
  const sameExpectation = () => canonicalJourneyJSON(context.owner.retryExpectation) === expectedBytes;
  let identity: CommandIdentity;
  if (receipt?.identity) identity = receipt.identity;
  else if (!receipt && expected) identity = { commandId: expected.command.clientRequestId, requestFingerprint: await studyBrowserHash(expected.command) };
  else return false;
  if (expected && (identity.commandId !== expected.command.clientRequestId || identity.requestFingerprint !== await studyBrowserHash(expected.command))) throw Error('study_submission_identity_changed');
  requireCurrent(context);
  // The caller's synchronous confirmation is specific to this frozen identity.
  if (receipt?.state !== 'cancelled') {
    if (!confirmCancel()) return false;
    requireCurrent(context);
  }
  if (!canCancelStudySubmission(context.owner, recovery) || !sameExpectation()) return false;
  if (receipt?.state !== 'cancelled') {
    const cancelled = await postTransition(context.scope, context.owner.actorId, identity, 'cancel');
    checkResponse(cancelled, context);
    const raw = await readStudySubmissionJson(cancelled); requireCurrent(context);
    identity = verifyStudySubmissionTransition(raw, context.scope, context.owner.actorId, identity, 'cancelled', 'either');
  }
  requireCurrent(context);
  if (!sameExpectation()) throw Error('study_submission_identity_changed');
  const acknowledged = await postTransition(context.scope, context.owner.actorId, identity, 'acknowledge');
  checkResponse(acknowledged, context);
  const raw = await readStudySubmissionJson(acknowledged); requireCurrent(context);
  verifyStudySubmissionTransition(raw, context.scope, context.owner.actorId, identity, 'cancelled', true);
  if (!sameExpectation()) throw Error('study_submission_identity_changed');
  // Metadata-only cancellation cannot reauthorize source-bearing authored bytes,
  // even if permission changed after the last successful recovery GET.
  context.owner.quarantineDraft();
  return context.owner.resolveCancelled(identity.commandId);
}
