/** Parent-owned ephemeral intake lifetime. Panel mount/unmount never owns retirement. */
import { confirmIntakeResponse, INTAKE_MAX_DOCUMENT_BYTES, isVerifiedIntakeRead, prepareIntakeSave, readIntakeRefusal,
  type IntakeBegin, type IntakeLifecycleCommand, type IntakeRead, type IntakeSaveExpectation, type IntakeWriteResponse } from "./ortho-assessment-intake-client";
export const INTAKE_PERMISSION_KEY_MAX_BYTES = 8_192;
export interface IntakeOwnerScope {
  patientId: number; principalId: number;
  /** Includes session/role/permission revision, not a display name. Changes permanently retire the old owner. */
  permissionKey: string;
  selectedOrthoCaseId: number | null; selectedClinicalCaseId: number | null;
}
export interface IntakeOwnerAccess { authorized(): boolean; writable(): boolean; deny(): void }
export interface IntakeRequest {
  readonly body: string; readonly command: IntakeLifecycleCommand;
  current(): boolean; checkHeaders(response: Pick<Response, "status">): boolean;
  confirmResponse(raw: unknown, status: number): Promise<boolean>;
  refuse(raw: unknown, status: number): boolean; markUncertain(): void; finish(): void;
}
export interface IntakeLease {
  readonly document: string;
  current(): boolean; editable(): boolean;
  /** Every mutation requires the exact document and generation captured by this lease. */
  change(serializedDraft: string): boolean; settle(serializedDraft: string): boolean; discard(): boolean;
  begin(expected: IntakeBegin): IntakeRequest | null;
  /** No command argument: retries always reuse the retained immutable command/body. */
  beginRetry(): IntakeRequest | null;
  /** GET loading can be async; both generation and exact document must still match. */
  acceptRead(read: IntakeRead): boolean;
}
export interface IntakeOwner {
  readonly scope: Readonly<IntakeOwnerScope>; readonly document: string; readonly busy: boolean; readonly uncertain: boolean;
  readonly dirty: boolean; readonly readVersion: number; readonly retired: boolean; readonly recoveryBlocked: boolean; readonly read: IntakeRead | null;
  readonly confirmed: IntakeWriteResponse | null;
  authorized(): boolean; writable(): boolean; editable(): boolean; lease(): IntakeLease;
  invalidateRead(): void; denied(): void; canLeave(confirmDiscard: () => boolean): boolean; needsUnloadWarning(): boolean;
  subscribe(listener: () => void): () => void; retire(): void;
}
export interface IntakeOwnerSlot {
  /** Keep this slot in the patient-detail parent; do not recreate or clear it when a tab hides. */
  select(scope: IntakeOwnerScope, access: IntakeOwnerAccess): IntakeOwner;
  readonly current: IntakeOwner | null;
  retire(): void;
}
/** Opaque, memory-only ledger. Its contents have no public read/export API. */
declare const recoveryBrand: unique symbol;
export interface IntakeRecoveryLedger {
  readonly [recoveryBrand]: true;
  /** Generic warning only, including when the pending patient is not the visible one. */
  needsUnloadWarning(): boolean; subscribe(listener: () => void): () => void;
}
/** Budgets apply to retained serialized payloads; unresolved commands are never evicted. */
export const INTAKE_RECOVERY_MAX_ENTRIES = 16;
export const INTAKE_RECOVERY_MAX_BYTES = 1_048_576;
type FrozenCommand = { expected: IntakeSaveExpectation; body: string; authoredDocument: string; cleanDocument: string;
  scope: Readonly<IntakeOwnerScope> };
const recoveryBytes = (entry: FrozenCommand) => new TextEncoder().encode(JSON.stringify(entry)).byteLength;
const totalRecoveryBytes = (entries: Map<string, FrozenCommand>) => [...entries.values()].reduce((sum, entry) => sum + recoveryBytes(entry), 0);
const recoveries = new WeakMap<IntakeRecoveryLedger, Map<string, FrozenCommand>>();
const recoveryNotifications = new WeakMap<IntakeRecoveryLedger, () => void>();
export function makeIntakeRecoveryLedger(): IntakeRecoveryLedger {
  const entries = new Map<string, FrozenCommand>(), listeners = new Set<() => void>();
  const ledger = Object.freeze({
    needsUnloadWarning: () => entries.size > 0,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  }) as IntakeRecoveryLedger;
  recoveries.set(ledger, entries);
  recoveryNotifications.set(ledger, () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Observers cannot interrupt ownership transitions. */ } } });
  return ledger;
}
const recoveryKey = (scope: IntakeOwnerScope) => JSON.stringify([scope.patientId, scope.selectedOrthoCaseId, scope.selectedClinicalCaseId, scope.principalId]);
const relatedRecovery = (entry: FrozenCommand, scope: IntakeOwnerScope) => {
  // Canonical merge can move the patient while both stable case identities remain unchanged.
  // Quarantine that pair without rewriting the original query owner, actor or command bytes.
  const sameCasePair = scope.selectedOrthoCaseId !== null && scope.selectedClinicalCaseId !== null
    && entry.scope.selectedOrthoCaseId === scope.selectedOrthoCaseId && entry.scope.selectedClinicalCaseId === scope.selectedClinicalCaseId;
  return sameCasePair || entry.scope.patientId === scope.patientId
    && (entry.expected.command.kind === "open_assessment" || scope.selectedOrthoCaseId === null);
};
const id = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const validScope = (s: IntakeOwnerScope) => id(s.patientId) && id(s.principalId) && typeof s.permissionKey === "string"
  && s.permissionKey.length > 0 && s.permissionKey.length <= INTAKE_PERMISSION_KEY_MAX_BYTES
  && new TextEncoder().encode(s.permissionKey).byteLength <= INTAKE_PERMISSION_KEY_MAX_BYTES
  && (s.selectedOrthoCaseId === null && s.selectedClinicalCaseId === null || id(s.selectedOrthoCaseId) && id(s.selectedClinicalCaseId));
const scopeKey = (s: IntakeOwnerScope) => JSON.stringify([s.patientId, s.principalId, s.permissionKey, s.selectedOrthoCaseId, s.selectedClinicalCaseId]);
const boundedDocument = (v: string) => typeof v === "string" && v.length <= INTAKE_MAX_DOCUMENT_BYTES && new TextEncoder().encode(v).byteLength <= INTAKE_MAX_DOCUMENT_BYTES;
/** Exported for a single already-scoped parent. Prefer makeIntakeOwnerSlot for A→B→A navigation. */
export function makeIntakeOwner(scopeInput: IntakeOwnerScope, initialAccess: IntakeOwnerAccess, recovery: IntakeRecoveryLedger): IntakeOwner {
  if (!validScope(scopeInput)) throw new Error("invalid_intake_owner_scope");
  const scope = Object.freeze({ ...scopeInput });
  const ledger = recoveries.get(recovery);
  if (!ledger) throw new Error("invalid_intake_recovery_ledger");
  const key = recoveryKey(scope);
  let access = initialAccess, generation = 0, readVersion = 0;
  let retired = false, document = "", clean = "", busy = false, uncertain = false;
  let currentRead: IntakeRead | null = null, confirmed: IntakeWriteResponse | null = null;
  let frozen: FrozenCommand | null = ledger.get(key) ?? null;
  if (frozen) { document = frozen.authoredDocument; clean = frozen.cleanDocument; uncertain = true; }
  const recoveryBlocked = () => [...ledger.values()].some(entry => entry !== frozen && relatedRecovery(entry, scope))
    || !frozen && (ledger.size >= INTAKE_RECOVERY_MAX_ENTRIES || totalRecoveryBytes(ledger) >= INTAKE_RECOVERY_MAX_BYTES);
  let pending: { active: boolean; confirmed: IntakeWriteResponse | null; refused: boolean } | null = null;
  const listeners = new Set<() => void>();
  // A readonly owner remains useful. Any later capability transition needs a fresh scope lifetime.
  let firstAuthority: { authorized: boolean; writable: boolean } | null = null;
  const notify = () => { for (const listener of [...listeners]) { try { listener(); } catch { /* Observers cannot interrupt ownership transitions. */ } } };
  const retire = () => {
    if (retired) return;
    retired = true; generation++;
    if (pending) pending.active = false;
    pending = null; busy = false; uncertain = false; frozen = null; currentRead = null; confirmed = null; document = ""; clean = "";
    notify(); listeners.clear();
  };
  const permissions = (): { authorized: boolean; writable: boolean } => {
    if (retired) return { authorized: false, writable: false };
    let authorized = false, writable = false;
    try { authorized = access.authorized(); writable = authorized && access.writable(); } catch { retire(); return { authorized: false, writable: false }; }
    const next = { authorized, writable };
    if (!firstAuthority) firstAuthority = next;
    else if (firstAuthority.authorized !== authorized || firstAuthority.writable !== writable) { retire(); return { authorized: false, writable: false }; }
    if (!authorized) { retire(); return { authorized: false, writable: false }; }
    return next;
  };
  // Capture immediately, so a revocation before the first callback cannot be mistaken for initial read-only access.
  permissions();
  const authorized = () => permissions().authorized;
  const writable = () => permissions().writable;
  const editable = () => writable() && !busy && !uncertain && !recoveryBlocked();
  const sameReadScope = (read: IntakeRead) => read.patientId === scope.patientId
    && (scope.selectedOrthoCaseId === null || read.openCase?.orthoCaseId === scope.selectedOrthoCaseId && read.openCase.clinicalCaseId === scope.selectedClinicalCaseId);
  const deny = () => { retire(); access.deny(); };
  const invalidateRead = () => {
    if (retired) return;
    generation++; readVersion++; currentRead = null; confirmed = null;
    if (pending || frozen) uncertain = true;
    // A stale attempt is retired, but its exact immutable bytes remain retryable.
    if (pending) pending.active = false;
    pending = null; busy = false; notify();
  };
  const start = (leaseCurrent: () => boolean, input: IntakeBegin | null, retry: boolean): IntakeRequest | null => {
    if (!leaseCurrent() || !writable() || busy || recoveryBlocked() || (retry ? !uncertain || !frozen : uncertain)) return null;
    if (!retry) {
      if (!input || input.read !== currentRead || !sameReadScope(input.read)) return null;
      const prepared = prepareIntakeSave(input);
      if (!prepared.ok) return null;
      const command = prepared.value.expected.command;
      if (command.kind !== "open_assessment" && (scope.selectedOrthoCaseId !== command.orthoCaseId || scope.selectedClinicalCaseId !== command.clinicalCaseId)) return null;
      const candidate = Object.freeze({ ...prepared.value, authoredDocument: document, cleanDocument: clean, scope });
      if (ledger.size >= INTAKE_RECOVERY_MAX_ENTRIES || totalRecoveryBytes(ledger) + recoveryBytes(candidate) > INTAKE_RECOVERY_MAX_BYTES) return null;
      frozen = candidate;
      // Reserve exact bytes before the caller starts transport. Retirement cannot erase uncertainty.
      ledger.set(key, frozen);
    }
    if (!frozen) return null;
    const captured = frozen, requestGeneration = ++generation;
    const operation = { active: true, confirmed: null as IntakeWriteResponse | null, refused: false };
    pending = operation; busy = true; confirmed = null;
    if (!retry) recoveryNotifications.get(recovery)?.(); notify();
    const owns = () => !retired && operation.active && pending === operation && frozen === captured && ledger.get(key) === captured;
    const live = () => owns() && writable() && requestGeneration === generation && document === captured.authoredDocument;
    if (!live()) {
      if (owns()) { operation.active = false; pending = null; busy = false; uncertain = true; generation++; notify(); }
      return null;
    }
    return Object.freeze({
      body: captured.body, command: captured.expected.command,
      current: live,
      checkHeaders(response: Pick<Response, "status">) {
        if (!live()) return false;
        if (response.status === 401 || response.status === 403) { uncertain = true; deny(); return false; }
        return true;
      },
      async confirmResponse(raw: unknown, status: number) {
        if (!live() || operation.refused || (status !== 200 && status !== 201)) return false;
        // Captured command/body cannot be rebuilt from a newer draft, read, or status.
        const value = await confirmIntakeResponse(raw, captured.expected, captured.body);
        // No async digest is allowed to acknowledge a stale principal, permission, read or view.
        if (!live() || !value || status !== (value.replayed ? 200 : 201)) return false;
        operation.confirmed = value; return true;
      },
      refuse(raw: unknown, status: number) {
        if (!live() || retry || operation.confirmed || !readIntakeRefusal(raw, status)) return false;
        operation.refused = true; return true;
      },
      markUncertain() {
        if (!owns()) return;
        uncertain = true; operation.refused = false; operation.confirmed = null; notify();
      },
      finish() {
        if (!owns()) return;
        const permitted = live();
        if (!owns()) return; // A synchronous authority check may permanently retire this owner.
        operation.active = false; pending = null; busy = false;
        let recoveryChanged = false;
        if (operation.confirmed && permitted) {
          ledger.delete(key); recoveryChanged = true; confirmed = operation.confirmed; document = ""; clean = ""; frozen = null; uncertain = false;
          currentRead = null; readVersion++; generation++;
        } else if (operation.refused && permitted && !retry && !uncertain) {
          ledger.delete(key); recoveryChanged = true; frozen = null; generation++; // Keep the authored draft after a proven initial refusal.
        } else { uncertain = true; generation++; }
        if (recoveryChanged) recoveryNotifications.get(recovery)?.();
        notify();
      },
    });
  };
  const owner: IntakeOwner = {
    scope,
    get document() { return document; }, get busy() { return busy; }, get uncertain() { return uncertain; },
    get dirty() { return document !== clean; }, get recoveryBlocked() { return recoveryBlocked(); }, get readVersion() { return readVersion; }, get retired() { return retired; },
    get read() { return currentRead; }, get confirmed() { return confirmed; }, authorized, writable, editable,
    lease() {
      const viewGeneration = generation, exactDocument = document;
      const current = () => !retired && authorized() && viewGeneration === generation && exactDocument === document;
      const changeable = () => current() && editable();
      const set = (value: string, settle: boolean) => {
        if (!changeable() || !boundedDocument(value)) return false;
        document = value; if (settle) clean = value;
        // Even A→B→A exact text must not reactivate an old callback.
        generation++; notify(); return true;
      };
      return Object.freeze({
        document: exactDocument, current, editable: changeable,
        change: (value: string) => set(value, false), settle: (value: string) => set(value, true),
        discard() { return set(clean, false); },
        begin: (input: IntakeBegin) => start(current, input, false),
        beginRetry: () => start(current, null, true),
        acceptRead(read: IntakeRead) {
          if (!current() || !isVerifiedIntakeRead(read) || !sameReadScope(read)) return false;
          currentRead = read;
          // GET alone never clears a frozen command, dirty bytes or uncertainty.
          generation++; notify(); return true;
        },
      });
    },
    invalidateRead, denied: deny,
    canLeave(confirmDiscard: () => boolean) {
      if (retired) return true;
      if (busy || uncertain) return false;
      if (document === clean) return true;
      const beforeGeneration = generation, beforeDocument = document;
      return confirmDiscard() && !retired && beforeGeneration === generation && beforeDocument === document && !busy && !uncertain;
    },
    needsUnloadWarning: () => recovery.needsUnloadWarning() || !retired && (busy || uncertain || document !== clean),
    subscribe(listener: () => void) { if (retired) return () => {}; listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire,
  };
  // Slot rebinding updates live parent callbacks without changing or resetting the lifetime.
  ownerAccessSetters.set(owner, next => { access = next; permissions(); });
  return owner;
}
const ownerAccessSetters = new WeakMap<IntakeOwner, (access: IntakeOwnerAccess) => void>();
export function makeIntakeOwnerSlot(recovery: IntakeRecoveryLedger): IntakeOwnerSlot {
  let owner: IntakeOwner | null = null, selectedKey: string | null = null;
  return {
    get current() { return owner; },
    select(scope, access) {
      if (!validScope(scope)) throw new Error("invalid_intake_owner_scope");
      const key = scopeKey(scope);
      if (!owner || owner.retired || key !== selectedKey) {
        owner?.retire(); owner = makeIntakeOwner(scope, access, recovery); selectedKey = key;
      } else {
        ownerAccessSetters.get(owner)?.(access);
        if (owner.retired) owner = makeIntakeOwner(scope, access, recovery);
      }
      return owner;
    },
    retire() { owner?.retire(); owner = null; selectedKey = null; },
  };
}
