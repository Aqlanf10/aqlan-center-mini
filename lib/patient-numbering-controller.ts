/** UNMOUNTED server seam. No route, real owner binding, token issuer, credentials,
 * environment access or default database activation. Dependencies must be supplied
 * by separately reviewed server wiring, never by request JSON.
 */
import { executeNumberingCommand, type CommandResult, type NumberingBackend, type NumberingTransaction } from './patient-numbering-command';
import { parseNumberingRequest } from './patient-numbering-policy';
import { staffAuthorizationFingerprint, type ResolvedStaffAccess } from './staff-capabilities';

export interface PatientNumberingPreviewCommand {
  readonly prefix: string; readonly next: string; readonly expectedRevision: string;
  readonly requestId: string; readonly reason: string;
}
/** Authenticated preview claims, not an authentication credential or editable grant. */
export interface PatientNumberingPreviewClaims {
  readonly version: 1;
  readonly purpose: 'patient-numbering.change';
  readonly actorId: number;
  readonly authorityFingerprint: string;
  readonly sessionBinding: string;
  readonly command: PatientNumberingPreviewCommand;
  readonly expiresAt: number;
}
export interface PatientNumberingControllerDependencies {
  backend: NumberingBackend;
  requireDisposition?: true;
  /** Resolve CURRENT authenticated request/session identity and revocation/expiry
   * under the transaction's authority locks. Never read this value from the body.
   * Return null for revoked, expired, missing or otherwise invalid credentials.
   */
  currentSessionBinding?(tx: NumberingTransaction): Promise<string | null>;
  /** Verify token authenticity, purpose/audience and complete claims using a reviewed
   * server provider. No provider exists here. May return authenticated expired claims
   * for exact receipt recovery; this controller forbids expired new writes.
   */
  verifyPreview(token: string, tx: NumberingTransaction): Promise<PatientNumberingPreviewClaims | null>;
  now?: () => number;
}
const commandKeys = ['prefix', 'next', 'expectedRevision', 'requestId', 'reason'];
function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Reflect.ownKeys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
}
function command(value: Record<string, unknown>): PatientNumberingPreviewCommand | null {
  const parsed = parseNumberingRequest(value.prefix, value.next);
  if (!parsed || typeof value.expectedRevision !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.expectedRevision)
    || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.requestId)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 500) return null;
  return Object.freeze({ ...parsed, expectedRevision: value.expectedRevision, requestId: value.requestId, reason: value.reason.trim() });
}
function sameCommand(a: PatientNumberingPreviewCommand, b: PatientNumberingPreviewCommand): boolean {
  return a.prefix === b.prefix && a.next === b.next && a.expectedRevision === b.expectedRevision
    && a.requestId === b.requestId && a.reason === b.reason;
}
function claims(value: unknown): PatientNumberingPreviewClaims | null {
  if (!record(value) || value.version !== 1 || value.purpose !== 'patient-numbering.change'
    || !Number.isSafeInteger(value.actorId) || (value.actorId as number) <= 0
    || typeof value.authorityFingerprint !== 'string' || !value.authorityFingerprint
    || typeof value.sessionBinding !== 'string' || !value.sessionBinding || value.sessionBinding.length > 8192
    || !Number.isSafeInteger(value.expiresAt) || (value.expiresAt as number) <= 0
    || !record(value.command) || !exactKeys(value.command, commandKeys)) return null;
  const parsed = command(value.command);
  if (!parsed || !sameCommand(parsed, value.command as unknown as PatientNumberingPreviewCommand)) return null;
  // Copy verified primitive claims so a provider cannot later mutate the bound intent.
  return Object.freeze({ version: 1, purpose: 'patient-numbering.change', actorId: value.actorId as number,
    authorityFingerprint: value.authorityFingerprint, sessionBinding: value.sessionBinding,
    command: parsed, expiresAt: value.expiresAt as number });
}

export async function executePatientNumberingSave(
  raw: unknown, dependencies: PatientNumberingControllerDependencies | null = null,
): Promise<CommandResult> {
  if (!dependencies || typeof dependencies.backend?.transaction !== 'function'
    || (dependencies.backend.authenticatedOwnerSession !== true && typeof dependencies.currentSessionBinding !== 'function')
    || typeof dependencies.verifyPreview !== 'function'
    || (dependencies.now !== undefined && typeof dependencies.now !== 'function')) {
    return { ok: false, reason: 'owner-numbering-not-activated' };
  }
  let input: PatientNumberingPreviewCommand | null, previewToken: string;
  try {
    if (!record(raw) || !exactKeys(raw, [...commandKeys, 'previewToken'])
      || typeof raw.previewToken !== 'string' || !raw.previewToken.trim() || raw.previewToken.length > 8192) {
      return { ok: false, reason: 'invalid-input' };
    }
    input = command(raw); previewToken = raw.previewToken;
    if (!input) return { ok: false, reason: 'invalid-input' };
  } catch { return { ok: false, reason: 'invalid-input' }; }
  const accepted = input;
  const installed = dependencies;
  const clock = installed.now ?? Date.now;
  let refusal: string | null = null;
  function refuse(reason: string): never { refusal = reason; throw new Error('Numbering controller refused'); }
  const backend: NumberingBackend = {
    transaction: work => installed.backend.transaction(async tx => {
      let preview: PatientNumberingPreviewClaims | null = null, applied = false;
      async function authoritativeOwner(): Promise<{ access: ResolvedStaffAccess; fingerprint: string; session: string }> {
        // Mounted wiring must choose the backend-native pair. The old callback is
        // retained only for abstract/in-memory tests and is never a fallback here.
        if (installed.backend.authenticatedOwnerSession === true && !tx.ownerSession) refuse('owner-numbering-not-activated');
        const paired = tx.ownerSession ? await tx.ownerSession() : null;
        const access = tx.ownerSession ? paired?.access ?? null : await tx.owner();
        const fingerprint = access && staffAuthorizationFingerprint(access);
        if (!access || !fingerprint || !access.isOwner || access.userId === null) refuse('owner-required');
        const session = tx.ownerSession ? paired?.sessionBinding : await installed.currentSessionBinding?.(tx);
        if (typeof session !== 'string' || !session || session.length > 8192) refuse('session-required');
        return { access, fingerprint, session };
      }
      function matchesAuthority(current: Awaited<ReturnType<typeof authoritativeOwner>>): void {
        if (!preview || current.access.userId !== preview.actorId || current.fingerprint !== preview.authorityFingerprint
          || current.session !== preview.sessionBinding) refuse('preview-authority-changed');
      }
      function expired(): boolean {
        const now = clock();
        if (!Number.isSafeInteger(now) || now < 0) refuse('numbering-clock-unavailable');
        return !preview || now >= preview.expiresAt;
      }
      async function recheck(newWrite = false): Promise<void> {
        matchesAuthority(await authoritativeOwner());
        if (newWrite && !tx.disposition && expired()) refuse('preview-expired');
      }
      const guarded: NumberingTransaction = {
        owner: async () => {
          if (installed.requireDisposition && !tx.disposition) refuse('owner-numbering-not-activated');
          const current = await authoritativeOwner();
          if (installed.requireDisposition && !await tx.disposition?.ready(current.access.userId!)) refuse('owner-required');
          preview = claims(await installed.verifyPreview(previewToken, tx));
          if (!preview) refuse('invalid-preview');
          matchesAuthority(current);
          if (!sameCommand(preview.command, accepted)) refuse('preview-command-mismatch');
          return current.access;
        },
        replay: async (actor, request) => {
          await recheck();
          const disposition = tx.disposition ? await tx.disposition.inspect(actor, request, preview!.expiresAt) : null;
          if (disposition === 'retired' || disposition === 'unknown') refuse('receipt-unresolved');
          const prior = await tx.replay(actor, request);
          if (disposition !== null && (disposition === 'committed') !== Boolean(prior)) refuse('receipt-unresolved');
          await recheck();
          // Expiry cannot authorize a new operation, but must not force a second
          // operation after a committed response was lost. Exact intent comparison
          // remains the existing command's responsibility before replay succeeds.
          if (!prior && (disposition === 'expired' || (disposition === null && expired()))) refuse('preview-expired');
          return prior;
        },
        snapshot: async prefix => { await recheck(true); return tx.snapshot(prefix); },
        apply: async change => {
          await recheck(true);
          if (!preview || change.actorId !== preview.actorId || change.authorityFingerprint !== preview.authorityFingerprint) refuse('preview-authority-changed');
          const result = await tx.apply(tx.disposition ? { ...change, dispositionExpiry: preview.expiresAt } : change); applied = true;
          await recheck(true);
          if (tx.disposition && await tx.disposition.inspect(change.actorId, change.requestId, preview.expiresAt) !== 'committed') {
            refuse('receipt-unresolved');
          }
          return result;
        },
      };
      const result = await work(guarded);
      if (preview) await recheck(applied); // Still inside the same transaction, before commit.
      return result;
    }),
  };
  // Use the existing command for validation, receipt intent, revision planning and
  // application. No nested transaction and no alternate numbering writer.
  const result = await executeNumberingCommand(accepted, backend);
  return refusal ? { ok: false, reason: refusal } : result;
}
