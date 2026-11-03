import { checkRetentionEventCommand } from "./ortho-retention-events";
import { verifyRetentionSaved, type RetentionSaveExpectation } from "./ortho-retention-client";
import type { JourneyScope } from "./ortho-case-journey-records";
import type { RetentionRecoveryLedger } from "./ortho-retention-recovery";
/** One non-revivable view owner, backed by a longer-lived recovery ledger. */
export function makeRetentionOwner(input: JourneyScope & { actorId: number; recovery: RetentionRecoveryLedger;
  authorized(): boolean; writable(): boolean; admitFresh(expected: RetentionSaveExpectation): boolean; canDiscardQuarantined(): boolean; deny(): void }) {
  const recovery = input.recovery.forOwner(input, input.actorId);
  const draftRecovery = input.recovery.forDraftOwner(input, input.actorId);
  let draftToken: object | null = null;
  const draftBlocked = () => { const row = draftRecovery.read(); return !!row && (!row.owned || row.owned.token !== draftToken); };
  const clearDraft = () => { if (draftToken !== null && !draftRecovery.discard(draftToken)) return false; draftToken = null; return true; };
  let generation = 0, active = false, retired = false, readDenied = false, document = "", clean = "", readVersion = 0;
  let submissionIssue: "recovery_capacity" | null = null;
  let pending: { active: boolean; confirmed: boolean; refused: boolean; token: object } | null = null;
  const listeners = new Set<() => void>();
  const current = () => active && !readDenied && input.authorized();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const unsubscribeRecovery = recovery.subscribe(notify);
  const deny = () => {
    readDenied = true;
    const row = recovery.read(); if (row?.owned) recovery.markUncertain(row.owned.token);
    try { input.deny(); } finally { notify(); }
  };
  const discard = (confirmDiscard: () => boolean, quarantine: boolean) => {
    const permitted = () => active && !retired && !readDenied && (quarantine ? input.canDiscardQuarantined() : current());
    if (recovery.read() || draftBlocked()) return false;
    if (document === clean) return true;
    if (!permitted()) return false;
    const before = document, token = draftToken, capturedGeneration = generation;
    if (!confirmDiscard() || !permitted() || generation !== capturedGeneration || document !== before || draftToken !== token
      || draftBlocked() || recovery.read() || !clearDraft()) return false;
    document = clean; notify(); return true;
  };
  const start = (expected: RetentionSaveExpectation | null, retry: boolean, expectedDocument?: string) => {
    submissionIssue = null;
    if (!current() || !input.writable() || draftBlocked() || !retry && expectedDocument !== document) return null;
    let saved = recovery.read();
    if (retry ? !saved?.owned || saved.pending || !saved.uncertain : saved !== null) return null;
    const actual = retry ? saved!.owned!.expected : expected;
    if (!actual) return null;
    const parsed = checkRetentionEventCommand(actual.command);
    if (!parsed.ok || actual.actorId !== input.actorId || actual.scope.patientId !== input.patientId || actual.scope.orthoCaseId !== input.orthoCaseId
      || actual.scope.clinicalCaseId !== input.clinicalCaseId || !Number.isSafeInteger(actual.previousVersion) || actual.previousVersion < 0 || actual.previousVersion >= 5000
      || (parsed.value.expectedHeadId === null) !== (actual.previousVersion === 0)) return null;
    const normalized = { scope: { patientId: input.patientId, orthoCaseId: input.orthoCaseId, clinicalCaseId: input.clinicalCaseId },
      actorId: input.actorId, command: parsed.value, previousVersion: actual.previousVersion };
    if (!retry && !input.admitFresh(normalized)) return null;
    let token: object;
    if (retry) { token = saved!.owned!.token; if (!recovery.retry(token)) return null; }
    else {
      const reserved = recovery.reserve(normalized, JSON.stringify({ patientId: input.patientId, command: parsed.value }), document, clean);
      if (!reserved) { submissionIssue = "recovery_capacity"; notify(); return null; } token = reserved;
    }
    saved = recovery.read(); const captured = saved!.owned!;
    const requestGeneration = generation, operation = { active: true, confirmed: false, refused: false, token };
    pending = operation;
    const owns = () => active && operation.active && pending === operation;
    const live = () => owns() && current() && input.writable() && !draftBlocked() && requestGeneration === generation;
    return {
      orthoCaseId: input.orthoCaseId, body: captured.body, current: live,
      checkHeaders(response: Response) {
        if (!live()) return false;
        if (response.status === 401 || response.status === 403) { recovery.markUncertain(token); deny(); return false; }
        return true;
      },
      async confirmResponse(raw: unknown, status: number) {
        if (!live()) return false;
        const verified = await verifyRetentionSaved(raw, captured.expected, status);
        if (!live() || status !== (verified.replayed ? 200 : 201)) return false;
        operation.confirmed = true; return true;
      },
      refuse(status: number) { if (live() && !retry && [400, 404, 409, 413].includes(status)) operation.refused = true; },
      markUncertain() { recovery.markUncertain(token); },
      finish() {
        if (!operation.active) return;
        const permitted = live(); operation.active = false; if (pending === operation) pending = null;
        const resolved = permitted && (operation.confirmed || operation.refused && !retry);
        if (operation.confirmed && permitted && clearDraft()) { document = ""; clean = ""; readVersion++; }
        // Even a retired request settles its transport in the ledger. It cannot
        // resolve authority, clear a returning owner's recovery or update its UI.
        recovery.settle(token, resolved);
      },
    };
  };
  return {
    matches: (scope: JourneyScope) => scope.patientId === input.patientId && scope.orthoCaseId === input.orthoCaseId && scope.clinicalCaseId === input.clinicalCaseId,
    get recoveryBlocked() { return draftBlocked(); },
    get actorId() { return input.actorId; }, get submissionIssue() { return submissionIssue; },
    get document() { return current() ? document : ""; }, get dirty() { return document !== clean; },
    get busy() { return recovery.read()?.pending ?? false; }, get uncertain() { const row = recovery.read(); return !!row && (row.uncertain || row.foreign); },
    get readVersion() { return readVersion; }, get retryExpectation() { return current() ? recovery.read()?.owned?.expected ?? null : null; },
    activate() {
      if (retired) return; active = true;
      const local = draftRecovery.read()?.owned;
      if (local && input.authorized()) { draftToken = local.token; document = local.document; clean = local.clean; }
      const prior = recovery.read()?.owned; if (prior && input.authorized()) { document = prior.document; clean = prior.clean; }
    },
    active: current, editable: () => current() && input.writable() && !draftBlocked() && recovery.read() === null,
    denied: deny,
    change(value: string) { if (current() && input.writable() && !draftBlocked() && !recovery.read()) {
      if (value === clean) { if (!clearDraft()) throw new Error("retention_draft_conflict"); }
      else { const token = draftRecovery.write(draftToken, value, clean); if (!token) throw new Error("retention_draft_capacity_or_conflict"); draftToken = token; }
      document = value; notify();
    } },
    settle(value: string) { if (current() && !draftBlocked() && !recovery.read() && document === clean) { document = value; clean = value; notify(); } },
    invalidateRead() { generation++; readVersion++; const row = recovery.read(); if (row?.owned) recovery.markUncertain(row.owned.token); notify(); },
    refresh() { if (current()) { readVersion++; notify(); } },
    begin: (expected: RetentionSaveExpectation, expectedDocument: string) => start(expected, false, expectedDocument), beginRetry: () => start(null, true),
    canRetry: () => { const row = recovery.read(); return current() && input.writable() && !draftBlocked() && !!row?.owned && !row.pending && row.uncertain; },
    canLeave(confirmDiscard: () => boolean) {
      if (!active) return !draftRecovery.read() && !recovery.read();
      return discard(confirmDiscard, false);
    },
    discardQuarantined: (confirmDiscard: () => boolean) => discard(confirmDiscard, true),
    needsUnloadWarning: () => !!recovery.read() || !!draftRecovery.read() || active && document !== clean,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    retire() {
      if (retired) return;
      active = false; retired = true; generation++;
      const row = recovery.read(); if (row?.owned) recovery.markUncertain(row.owned.token);
      // Do not clear or deactivate the outstanding operation: its transport may
      // still finish and must release pending while preserving uncertain identity.
      document = ""; clean = ""; listeners.clear(); unsubscribeRecovery();
    },
  };
}
export type RetentionOwner = ReturnType<typeof makeRetentionOwner>;
