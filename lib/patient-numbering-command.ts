/** Inert application service: no production adapter or owner bootstrap is installed.
 * A future adapter MUST lock allocator/configuration, refresh owner authority in
 * that transaction, atomically persist counter/config/audit/idempotency, and fail
 * closed on incomplete history. This module owns no database or environment.
 */
import { staffAuthorizationFingerprint, type ResolvedStaffAccess } from './staff-capabilities';
import { parseNumberingRequest, planPatientNumbering, type PrefixSnapshot } from './patient-numbering-policy';
export interface NumberingCommand {
  prefix: unknown; next: unknown; expectedRevision: unknown; requestId: unknown; reason: unknown;
}
export interface AppliedNumbering { prefix: string; next: string; preview: string; revision: string }
export type CommandResult = { ok: true; value: AppliedNumbering; replay: boolean } | { ok: false; reason: string };
export interface NumberingOwnerSession { readonly access: ResolvedStaffAccess; readonly sessionBinding: string }
export interface NumberingTransaction {
  disposition?: import('./patient-numbering-disposition').NumberingDisposition;
  /** Only present when the adapter provides fresh authenticated owner/session on this transaction. */
  ownerSession?(): Promise<NumberingOwnerSession | null>;
  /** Fresh, authenticated identity resolved under the same transaction's locks. */
  owner(): Promise<ResolvedStaffAccess | null>;
  replay(actorId: number, requestId: string, checkAuthority: () => Promise<void>): Promise<{ intent: string; result: AppliedNumbering } | null>;
  /** Revision MUST fence global active-prefix config AND this prefix's allocator. */
  snapshot(prefix: string): Promise<PrefixSnapshot>;
  /** Active config read under the same authenticated transaction. */
  currentNumbering?(): Promise<PrefixSnapshot>;
  /** Atomic adapter action, including audit and durable idempotency. Never setval. */
  apply(input: { actorId: number; authorityFingerprint: string; requestId: string; intent: string;
    reason: string; prefix: string; next: string; expectedRevision: string; preview: string; dispositionExpiry?: number },
    checkAuthority: () => Promise<void>): Promise<AppliedNumbering>;
}
export interface NumberingBackend {
  readonly authenticatedOwnerSession?: true;
  /** Serializes with ALL allocators; rollback on any error including audit failure. */
  transaction<T>(work: (tx: NumberingTransaction) => Promise<T>): Promise<T>;
}
export async function executeNumberingCommand(raw: NumberingCommand, backend: NumberingBackend | null): Promise<CommandResult> {
  // Production uses null until the separately governed owner binding + DB adapter exist.
  if (!backend) return { ok: false, reason: 'owner-numbering-not-activated' };
  const request = parseNumberingRequest(raw.prefix, raw.next);
  if (!request || typeof raw.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(raw.requestId)
    || typeof raw.expectedRevision !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.expectedRevision)
    || typeof raw.reason !== 'string' || !raw.reason.trim() || raw.reason.length > 500) {
    return { ok: false, reason: 'invalid-input' };
  }
  const requestId = raw.requestId, expectedRevision = raw.expectedRevision, reason = raw.reason.trim();
  const intent = JSON.stringify([request.prefix, request.next, expectedRevision, reason]);
  try {
    return await backend.transaction(async tx => {
      const first = tx.ownerSession ? await tx.ownerSession() : null;
      const access = tx.ownerSession ? first?.access : await tx.owner();
      const fingerprint = access && staffAuthorizationFingerprint(access);
      // Fingerprint validates the canonical resolver's private WeakMap, not JSON flags.
      if (!access || !fingerprint || !access.isOwner || access.userId === null || (tx.ownerSession && !first?.sessionBinding)) return { ok: false, reason: 'owner-required' };
      async function checkAuthority() {
        const fresh = tx.ownerSession ? await tx.ownerSession() : null;
        const current = tx.ownerSession ? fresh?.access : await tx.owner();
        if (!current?.isOwner || staffAuthorizationFingerprint(current) !== fingerprint
          || (tx.ownerSession && fresh?.sessionBinding !== first?.sessionBinding)) throw new Error('Numbering authority changed');
      }
      const prior = await tx.replay(access.userId, requestId, checkAuthority);
      if (prior) return prior.intent === intent
        ? { ok: true, value: prior.result, replay: true }
        : { ok: false, reason: 'idempotency-conflict' };
      const plan = planPatientNumbering(request, await tx.snapshot(request.prefix), expectedRevision);
      if (!plan.ok) return plan;
      const value = await tx.apply({ actorId: access.userId, authorityFingerprint: fingerprint,
        requestId, intent, reason, ...plan }, checkAuthority);
      return { ok: true, value, replay: false };
    });
  } catch {
    return { ok: false, reason: 'numbering-transaction-failed' };
  }
}
