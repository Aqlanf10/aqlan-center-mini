import 'server-only';
import type { DbClient, DbPool } from './db';
import type { VerifiedDurableSession } from './staff-durable-session';
import { withStaffOperation, type StaffOperationHandle } from './staff-operation-runtime';
import { createCanonicalFacialWriteAuthority } from './canonical-ortho-facial-authority';
import { createFacialAuditAdapter } from './ortho-facial-audit-adapter';
import { facialFail, facialHash, facialId, facialScope, type FacialClockPort, type FacialImagePort, type FacialScope, type FacialWriteAuthority, type FacialWritePorts } from './ortho-facial-core-contract';
import { parseFacialCoreCommand } from './ortho-facial-revision-core';
import { reserveFacialSubmissionWith, executeReservedFacialWith, transitionFacialSubmissionWith, type FacialSubmissionRequest, type FacialSubmissionTransition } from './ortho-facial-submission-core';

export class CanonicalFacialConflict extends Error {
  readonly status = 409;
  readonly code = 'facial_conflict';
  constructor() { super('Facial transaction conflict; retry only the identical request.'); }
}
async function boundary<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && ['55P03', '40P01', '40001'].includes(String(error.code))) throw new CanonicalFacialConflict();
    // In particular, cleanup rollback never proves an uncertain COMMIT failed.
    throw error;
  }
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freezeDeep(child); Object.freeze(value); }
  return value;
}
function exactKeys(input: unknown, keys: readonly string[]): boolean {
  return !!input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
}
function request(input: FacialSubmissionRequest): FacialSubmissionRequest {
  if (!exactKeys(input, ['patientId', 'orthoCaseId', 'clinicalCaseId', 'actorId', 'command'])) facialFail(400, 'invalid_facial_submission_scope');
  const scope = facialScope(input), clinicalCaseId = input.clinicalCaseId, actorId = input.actorId;
  if (!facialId(clinicalCaseId) || !facialId(actorId)) facialFail(400, 'invalid_facial_submission_scope');
  return freezeDeep({ ...scope, clinicalCaseId, actorId, command: structuredClone(parseFacialCoreCommand(input.command)) });
}
function transitionInput(input: FacialSubmissionTransition): FacialSubmissionTransition {
  if (!exactKeys(input, ['patientId', 'orthoCaseId', 'clinicalCaseId', 'actorId', 'commandId', 'requestFingerprint', 'action'])) facialFail(400, 'invalid_facial_submission_transition');
  const result = { ...facialScope(input), clinicalCaseId: input.clinicalCaseId, actorId: input.actorId, commandId: input.commandId, requestFingerprint: input.requestFingerprint, action: input.action };
  if (!facialId(result.clinicalCaseId) || !facialId(result.actorId) || typeof result.commandId !== 'string' || !/^[a-zA-Z0-9_-]{16,80}$/.test(result.commandId)
    || !facialHash(result.requestFingerprint) || !['cancel', 'acknowledge'].includes(result.action)) facialFail(400, 'invalid_facial_submission_transition');
  return Object.freeze(result);
}
/** INACTIVE server composition only. No default instance, read registration,
 * image implementation or authority stub. The trusted clock must use clinic time. */
export function createCanonicalFacialCommands({ pool, images, clock }: { pool: DbPool; images: FacialImagePort; clock: FacialClockPort }) {
  if (!pool || typeof pool.connect !== 'function' || !images || typeof images.verify !== 'function' || !clock || typeof clock.today !== 'function') facialFail(500, 'facial_core_port_invalid');
  // Pin implementation identity, not authorization. Shared trusted services may
  // retain their own receiver state; replacing their methods cannot change the
  // effective verifier/clock midway through either committed lifetime.
  const verify = images.verify, today = clock.today;
  const configuration = () => {
    if (images.verify !== verify || clock.today !== today) facialFail(500, 'facial_core_context_changed');
  };
  const guarded = async <T>(work: () => Promise<T>): Promise<T> => {
    configuration();
    const result = await work();
    configuration();
    return result;
  };
  const ports = (client: DbClient, handle: StaffOperationHandle, scope: FacialScope): FacialWritePorts => {
    configuration();
    const actual = createCanonicalFacialWriteAuthority(client, handle, scope);
    const authority: FacialWriteAuthority = {
      authorizeWrite: (passed, requested) => guarded(() => actual.authorizeWrite(passed, requested)),
      assertWrite: (passed, requested, actor) => guarded(() => actual.assertWrite(passed, requested, actor)),
      assertImages: (passed, requested, actor) => guarded(() => actual.assertImages(passed, requested, actor)),
    };
    return { mode: 'write', locking: 'nowait', authority,
      images: { verify: source => guarded(() => verify.call(images, source)) },
      clock: { today: () => { configuration(); const result = today.call(clock); configuration(); return result; } },
      audit: createFacialAuditAdapter(client, actor => authority.assertWrite(client, scope, actor)) };
  };
  const operation = <T>(session: VerifiedDurableSession, scope: FacialScope, work: (client: DbClient, ports: FacialWritePorts) => Promise<T>) =>
    boundary(() => guarded(() => withStaffOperation(pool, session, 'clinical.ortho.edit', (client, handle) =>
      guarded(() => work(client, ports(client, handle, scope))))));
  // Outer guard runs after confirmed COMMIT. Its refusal is not a rollback or
  // evidence of non-write, and save must not start a second lifetime afterwards.
  const reserve = (session: VerifiedDurableSession, input: FacialSubmissionRequest) => {
    const snapshot = request(input);
    return operation(session, snapshot, (client, fresh) => reserveFacialSubmissionWith(client, snapshot, fresh));
  };
  const execute = (session: VerifiedDurableSession, input: FacialSubmissionRequest) => {
    const snapshot = request(input);
    return operation(session, snapshot, (client, fresh) => executeReservedFacialWith(client, snapshot, fresh));
  };
  return Object.freeze({ reserve, execute,
    transition(session: VerifiedDurableSession, input: FacialSubmissionTransition) {
      const snapshot = transitionInput(input);
      return operation(session, snapshot, (client, fresh) => transitionFacialSubmissionWith(client, snapshot, fresh));
    },
    async save(session: VerifiedDurableSession, input: FacialSubmissionRequest) {
      const snapshot = request(input);
      await reserve(session, snapshot); // Fully confirmed first commit, not just callback completion.
      return execute(session, snapshot); // New handle, XID and closures, even on a reused client.
    },
  });
}
